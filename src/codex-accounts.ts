import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	type CodexOAuthProvider,
	getDefaultCodexOAuthProvider,
	type OAuthCredentials,
	type RefreshOnlyCodexOAuthProvider,
} from "./oauth.js";
import { RuntimeApiKeyController } from "./runtime-auth.js";
import {
	ACCOUNT_CHANGED_EVENT,
	ACCOUNT_STATE_TYPE,
	type AccountSelection,
	restoreAccountSelection,
} from "./session-state.js";
import {
	type CodexAccountStorageBackend,
	FileCodexAccountStorageBackend,
} from "./storage.js";

export const CODEX_PROVIDER_ID = "openai-codex";
export const DEFAULT_CODEX_MODEL_ID = "gpt-5.5";
export const CODEX_ACCOUNTS_FILE = "codex-accounts.json";
export const CODEX_ACCOUNTS_STATUS_KEY = "codex-accounts";
export const DEFAULT_PI_LOGIN_LABEL = "(default pi login)";
export const FAIL_CLOSED_API_KEY = "pi-codex-accounts-refresh-failed";
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const BACKGROUND_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const ACCOUNT_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const runtime = new RuntimeApiKeyController(CODEX_PROVIDER_ID);

export type StoredCodexCredential = OAuthCredentials;
export type CodexAccountsData = {
	default?: string;
	accounts: Record<string, StoredCodexCredential>;
};
export type EnsureActiveCodexAuthResult =
	| { status: "inactive" }
	| { status: "active"; accountName: string }
	| { status: "error"; accountName: string; message: string };
export type CommandArgumentCompletion = {
	value: string;
	label: string;
	description?: string;
};
export type CodexAccountsDependencies = {
	store?: CodexAccountStore;
	oauthProvider?: CodexOAuthProvider;
	closeWebSocketSessions?: (sessionId?: string) => unknown;
};

export class CodexAccountStore {
	constructor(
		private readonly backend: CodexAccountStorageBackend = new FileCodexAccountStorageBackend(
			join(getAgentDir(), CODEX_ACCOUNTS_FILE),
		),
	) {}
	read(): CodexAccountsData {
		return parseStoredData(this.backend.readRaw());
	}
	async readAsync(): Promise<CodexAccountsData> {
		return this.read();
	}
	async write(data: CodexAccountsData): Promise<void> {
		await this.update(() => data);
	}
	update(
		mutator: (data: CodexAccountsData) => CodexAccountsData,
	): Promise<CodexAccountsData> {
		return this.updateAsync(async (data) => mutator(data));
	}
	updateAsync(
		mutator: (data: CodexAccountsData) => Promise<CodexAccountsData>,
	): Promise<CodexAccountsData> {
		return this.backend.withLockAsync(async (current) => {
			const data = parseStoredData(current);
			const next = await mutator(data);
			// Returning the unchanged snapshot is a genuine no-op, including
			// legacy files: don't migrate/rewrite merely because we inspected it.
			return {
				result: next,
				...(next !== data ? { next: stringifyStoredData(next) } : {}),
			};
		});
	}
	async writeRawForTest(raw: string): Promise<void> {
		await this.backend.withLockAsync(async () => ({
			result: undefined,
			next: raw,
		}));
	}
}

/** Explicit name is session identity. `undefined` means shared default; null means built-in login. */
export async function ensureActiveCodexAuth(
	ctx: ExtensionContext,
	store: CodexAccountStore,
	options: {
		oauthProvider?: RefreshOnlyCodexOAuthProvider;
		now?: number;
		accountName?: string | null;
		allowRefresh?: boolean;
		isCurrent?: () => boolean;
	} = {},
): Promise<EnsureActiveCodexAuthResult> {
	const oauth =
		options.oauthProvider ?? getDefaultCodexOAuthProvider(CODEX_PROVIDER_ID);
	const snapshot = runtime.capture(ctx);
	const currentOperation = options.isCurrent ?? (() => true);
	let name = options.accountName;
	let lastError = "Credentials changed repeatedly; retry the account switch.";
	// Bound concurrent credential-change retries. No recursive re-entry, ever.
	for (let attempt = 0; attempt < 3; attempt++) {
		if (!currentOperation()) return { status: "inactive" };
		const data = await store.readAsync();
		name =
			options.accountName === undefined ? data.default : options.accountName;
		if (name === null || name === undefined) {
			await runtime.clear(ctx);
			return { status: "inactive" };
		}
		let credential = ownCredential(data.accounts, name);
		if (!credential) {
			lastError = `Saved account "${name}" is missing. Select another account; no fallback account was used.`;
			break;
		}
		try {
			if (credential.expires <= (options.now ?? Date.now()) + REFRESH_SKEW_MS) {
				if (options.allowRefresh === false) {
					lastError =
						"Token needs renewal; it will be refreshed before the next Codex turn.";
					break;
				}
				const accountName = name;
				await store.updateAsync(async (latest) => {
					const fresh = ownCredential(latest.accounts, accountName);
					if (!fresh || !currentOperation()) return latest;
					if (fresh.expires > (options.now ?? Date.now()) + REFRESH_SKEW_MS) {
						credential = fresh;
						return latest;
					}
					// Lock spans the complete cancellable request AND durable write.
					// Do not abandon this request with Promise.race.
					credential = normalizeCredential(await oauth.refreshToken(fresh));
					return {
						...latest,
						accounts: { ...latest.accounts, [accountName]: credential },
					};
				});
			}
			const apiKey = await oauth.getApiKey(credential);
			if (!currentOperation()) return { status: "inactive" };
			// Credential equality is independent of GLOBAL DEFAULT. Comparing
			// default===name here caused the old hot recursion/TUI freeze.
			if (
				!sameCredential(
					ownCredential((await store.readAsync()).accounts, name),
					credential,
				)
			)
				continue;
			const applied = await runtime.apply(ctx, snapshot, apiKey);
			if (applied === "stale") return { status: "inactive" };
			if (applied === "unavailable") {
				lastError = "Pi did not accept the runtime account token.";
				break;
			}
			return { status: "active", accountName: name };
		} catch (error) {
			lastError = redactCredentialError(error, credential);
			break;
		}
	}
	if (!currentOperation()) return { status: "inactive" };
	await runtime.apply(ctx, snapshot, FAIL_CLOSED_API_KEY);
	return {
		status: "error",
		accountName: name ?? "unknown",
		message: lastError,
	};
}

export async function refreshStoredAccounts(
	store: CodexAccountStore,
	options: { oauthProvider?: RefreshOnlyCodexOAuthProvider; now?: number } = {},
): Promise<Map<string, string>> {
	const oauth =
		options.oauthProvider ?? getDefaultCodexOAuthProvider(CODEX_PROVIDER_ID);
	const errors = new Map<string, string>();
	for (const [name, initial] of Object.entries(
		(await store.readAsync()).accounts,
	)) {
		if (initial.expires > (options.now ?? Date.now()) + REFRESH_SKEW_MS)
			continue;
		try {
			await store.updateAsync(async (data) => {
				const credential = ownCredential(data.accounts, name);
				if (
					!credential ||
					credential.expires > (options.now ?? Date.now()) + REFRESH_SKEW_MS
				)
					return data;
				const refreshed = normalizeCredential(
					await oauth.refreshToken(credential),
				);
				return { ...data, accounts: { ...data.accounts, [name]: refreshed } };
			});
		} catch (error) {
			errors.set(name, redactCredentialError(error, initial));
		}
	}
	return errors;
}

export default function codexAccounts(
	pi: ExtensionAPI,
	dependencies: CodexAccountsDependencies = {},
) {
	const store = dependencies.store ?? new CodexAccountStore();
	const oauth =
		dependencies.oauthProvider ??
		getDefaultCodexOAuthProvider(CODEX_PROVIDER_ID);
	let selection: AccountSelection | undefined;
	let generation = 0;
	let stopped = false;
	let loginAbort: AbortController | undefined;
	let backgroundBusy = false;
	let lastBackground = 0;
	let identity: string | undefined;
	let lastError: string | undefined;

	function publish(ctx: ExtensionContext) {
		pi.events.emit(ACCOUNT_CHANGED_EVENT, {
			sessionId: ctx.sessionManager.getSessionId(),
			accountName: selection?.accountName ?? null,
		});
		// Retain the already-shipped optional hook until event-bus consumers update.
		const hook = (globalThis as Record<string, unknown>).__piUsageStatusRefresh;
		if (typeof hook === "function") {
			try {
				hook();
			} catch {
				/* optional observer */
			}
		}
	}
	function saveSelection(name: string | null, ctx: ExtensionContext) {
		selection = { accountName: name };
		generation++;
		runtime.invalidate(ctx); // Queued token writes from an older switch cannot win.
		pi.appendEntry(ACCOUNT_STATE_TYPE, selection);
	}
	async function sync(
		ctx: ExtensionContext,
		allowRefresh = false,
		model = ctx.model,
	) {
		const operation = generation;
		const result = await ensureActiveCodexAuth(ctx, store, {
			oauthProvider: oauth,
			accountName: selection?.accountName,
			allowRefresh,
			isCurrent: () => !stopped && operation === generation,
		});
		if (stopped || operation !== generation) return result;
		const nextIdentity =
			result.status === "inactive"
				? "builtin"
				: `${result.status}:${result.accountName}`;
		if (identity !== nextIdentity) {
			await dependencies.closeWebSocketSessions?.(
				ctx.sessionManager.getSessionId(),
			);
			identity = nextIdentity;
		}
		ctx.ui.setStatus(
			CODEX_ACCOUNTS_STATUS_KEY,
			isOpenAICodexModel(model) && result.status !== "inactive"
				? `codex:${result.accountName}${result.status === "error" ? " auth error" : ""}`
				: undefined,
		);
		if (result.status === "error" && lastError !== result.message)
			ctx.ui.notify(
				`Codex account "${result.accountName}": ${result.message}`,
				"error",
			);
		lastError = result.status === "error" ? result.message : undefined;
		return result;
	}
	async function switchAccount(
		ctx: ExtensionCommandContext,
		name: string | null,
	) {
		if (name !== null && !ownCredential(store.read().accounts, name))
			throw new Error(`Codex account "${name}" was not found.`);
		saveSelection(name, ctx);
		const operation = generation;
		const result = await sync(ctx);
		if (stopped || generation !== operation) return;
		ctx.ui.notify(
			result.status === "error"
				? `Selected "${name}" for this session; ${result.message}`
				: name === null
					? "This session uses Pi's built-in Codex login."
					: `Activated Codex account "${name}" for this session.`,
			result.status === "error" ? "warning" : "info",
		);
		publish(ctx);
	}
	function guarded(
		fn: (args: string, ctx: ExtensionCommandContext) => Promise<void>,
	) {
		return async (args: string, ctx: ExtensionCommandContext) => {
			try {
				await fn(args, ctx);
			} catch (error) {
				ctx.ui.notify(redactTokenText(errorMessage(error)), "error");
			}
		};
	}

	pi.registerCommand("codex-account", {
		description:
			"Select this session's Codex account; default uses global default, builtin uses Pi login. --default explicitly saves global default.",
		getArgumentCompletions: (prefix) =>
			completeStoredAccountArguments(prefix, store),
		handler: guarded(async (args, ctx) => {
			let value = args.trim();
			if (!value) {
				if (!ctx.hasUI) {
					ctx.ui.notify(
						`Accounts: ${Object.keys(store.read().accounts).join(", ")}`,
						"info",
					);
					return;
				}
				value =
					(await ctx.ui.select("Select Codex account for THIS session", [
						"default",
						"builtin",
						...Object.keys(store.read().accounts).sort(),
					])) ?? "";
				if (!value) return;
			}
			const setDefault = /(?:^|\s)--default(?:\s|$)/.test(value);
			value = value.replace(/(?:^|\s)--default(?:\s|$)/g, " ").trim();
			const name =
				value === "default"
					? (store.read().default ?? null)
					: isBuiltinArg(value)
						? null
						: validName(value);
			if (name !== null && !ownCredential(store.read().accounts, name)) {
				throw new Error(`Codex account "${name}" was not found.`);
			}
			if (setDefault)
				await store.update((data) => ({ ...data, default: name ?? undefined }));
			await switchAccount(ctx, name);
		}),
	});
	pi.registerCommand("codex-default", {
		description:
			"Show or explicitly set GLOBAL default for new sessions. Existing sessions stay unchanged.",
		getArgumentCompletions: (prefix) =>
			completeStoredAccountArguments(prefix, store, { includeDefault: false }),
		handler: guarded(async (args, ctx) => {
			const value = args.trim();
			if (!value) {
				ctx.ui.notify(
					`Global Codex default: ${store.read().default ?? "builtin"}`,
					"info",
				);
				return;
			}
			const name = isBuiltinArg(value) ? null : validName(value);
			if (name !== null && !ownCredential(store.read().accounts, name))
				throw new Error(`No stored account "${name}".`);
			await store.update((data) => ({ ...data, default: name ?? undefined }));
			ctx.ui.notify(
				`Global default: ${name ?? "builtin"}. Existing sessions unchanged.`,
				"info",
			);
		}),
	});
	pi.registerCommand("codex-login", {
		description:
			"Re-login a named account, or confirm creating a new local account name. Escape cancels.",
		getArgumentCompletions: (prefix) =>
			completeStoredAccountArguments(prefix, store, { includeDefault: false }),
		handler: guarded(async (args, ctx) => {
			if (!ctx.hasUI) throw new Error("/codex-login requires interactive UI");
			if (loginAbort)
				throw new Error("A Codex login is already running in this session.");
			let name = validName(args);
			const accounts = store.read().accounts;
			const exact = Object.keys(accounts).find(
				(key) => key.toLowerCase() === name.toLowerCase(),
			);
			if (exact) name = exact;
			else {
				const close = Object.keys(accounts).filter(
					(key) => editDistance(key.toLowerCase(), name.toLowerCase()) <= 2,
				);
				const text =
					`Create local Codex account name "${name}"? Existing: ${Object.keys(accounts).join(", ") || "none"}.` +
					(close.length
						? ` Similar names: ${close.join(", ")}. Cancel and choose one to re-login instead.`
						: "") +
					" This does not create an OpenAI subscription.";
				if (!(await ctx.ui.confirm("New Codex account name", text))) return;
			}
			const controller = new AbortController();
			loginAbort = controller;
			const operation = generation;
			try {
				const credential = normalizeCredential(
					await loginCodexAccount(name, ctx, oauth, controller),
				);
				if (stopped || operation !== generation) return;
				let target = name;
				await store.update((data) => {
					// Keep an existing canonical name; never delete another name or
					// unrelated credentials implicitly. Old duplicates need explicit cleanup.
					if (!ownCredential(data.accounts, name))
						target =
							Object.keys(data.accounts).find(
								(key) =>
									credential.accountId &&
									data.accounts[key].accountId === credential.accountId,
							) ?? name;
					return {
						...data,
						accounts: { ...data.accounts, [target]: credential },
					};
				});
				if (target !== name)
					ctx.ui.notify(
						`Same OpenAI account already stored as "${target}"; refreshed that entry. No "${name}" entry created.`,
						"info",
					);
				await switchAccount(ctx, target);
			} finally {
				controller.abort();
				if (loginAbort === controller) loginAbort = undefined;
			}
		}),
	});
	pi.registerCommand("codex-logout", {
		description:
			"Remove shared credentials for an account (affects availability in all sessions); asks confirmation.",
		getArgumentCompletions: (prefix) =>
			completeStoredAccountArguments(prefix, store, { includeDefault: false }),
		handler: guarded(async (args, ctx) => {
			const name = validName(args);
			if (!ownCredential(store.read().accounts, name))
				throw new Error(`No stored account "${name}".`);
			if (
				!ctx.hasUI ||
				!(await ctx.ui.confirm(
					"Remove shared Codex credentials?",
					`Remove "${name}"? Other sessions using it will report missing credentials, not silently switch. Their session state will not change.`,
				))
			)
				return;
			await store.update((data) => {
				const accounts = { ...data.accounts };
				delete accounts[name];
				return { ...data, accounts };
			});
			await sync(ctx);
			publish(ctx);
			ctx.ui.notify(
				`Removed credentials for "${name}". Session selections and global default were not changed.`,
				"info",
			);
		}),
	});

	async function init(ctx: ExtensionContext) {
		stopped = false;
		selection = restoreAccountSelection(ctx.sessionManager.getBranch());
		if (!selection) {
			// Pin the default in THIS session's normal custom state, not shared JSON.
			// No credential file/lock is created or written at startup.
			saveSelection(store.read().default ?? null, ctx);
		} else generation++;
		await sync(ctx);
		publish(ctx);
	}
	function eventGuard(fn: (ctx: ExtensionContext) => Promise<void>) {
		return async (_event: unknown, ctx: ExtensionContext) => {
			try {
				await fn(ctx);
			} catch (error) {
				ctx.ui.notify(
					`Codex: ${redactTokenText(errorMessage(error))}`,
					"error",
				);
			}
		};
	}
	pi.on("session_start", eventGuard(init));
	pi.on(
		"session_tree",
		eventGuard(async (ctx) => {
			await init(ctx);
		}),
	);
	pi.on("model_select", async (event, ctx) => {
		try {
			await sync(ctx, false, event.model);
			publish(ctx);
		} catch (error) {
			ctx.ui.notify(`Codex: ${redactTokenText(errorMessage(error))}`, "error");
		}
	});
	pi.on(
		"before_agent_start",
		eventGuard(async (ctx) => {
			if (isOpenAICodexModel(ctx.model)) {
				await sync(ctx, true);
				publish(ctx);
			}
		}),
	);
	pi.on("agent_end", (_event, ctx) => {
		if (
			backgroundBusy ||
			Date.now() - lastBackground < BACKGROUND_REFRESH_INTERVAL_MS
		)
			return;
		lastBackground = Date.now();
		backgroundBusy = true;
		// Renew other stored accounts without blocking startup, model changes,
		// commands, or unrelated model turns. Lock stays held through each refresh.
		void refreshStoredAccounts(store, { oauthProvider: oauth })
			.then((errors) => {
				if (!stopped)
					for (const [name, message] of errors)
						ctx.ui.notify(
							`Codex account "${name}" renewal failed: ${message}`,
							"warning",
						);
			})
			.catch((error) => {
				if (!stopped)
					ctx.ui.notify(
						`Codex background renewal: ${redactTokenText(errorMessage(error))}`,
						"warning",
					);
			})
			.finally(() => {
				backgroundBusy = false;
			});
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		stopped = true;
		generation++;
		loginAbort?.abort();
		await runtime.clear(ctx);
		ctx.ui.setStatus(CODEX_ACCOUNTS_STATUS_KEY, undefined);
	});
}

export async function loginCodexAccount(
	name: string,
	ctx: ExtensionCommandContext,
	oauth: CodexOAuthProvider,
	controller = new AbortController(),
): Promise<OAuthCredentials> {
	const tag = `[codex:${name}]`;
	const timeout = setTimeout(
		() => controller.abort(new Error("Codex login timed out")),
		5 * 60 * 1000,
	);
	try {
		return await oauth.login({
			signal: controller.signal,
			onAuth: ({ url, instructions }) =>
				ctx.ui.notify(`${tag} ${url}\n${instructions ?? ""}`, "info"),
			onProgress: (text) => ctx.ui.notify(`${tag} ${text}`, "info"),
			onManualCodeInput: async () => {
				const value = await ctx.ui.input(
					`${tag} Waiting for browser login. Paste code/redirect URL if needed. Escape cancels.`,
					"",
					{ signal: controller.signal },
				);
				if (!value) {
					controller.abort(new Error("Codex login cancelled"));
					throw new Error("Codex login cancelled");
				}
				return value;
			},
			onPrompt: async (prompt) => {
				const value = await ctx.ui.input(
					`${tag} ${prompt.message}`,
					prompt.placeholder ?? "",
					{ signal: controller.signal },
				);
				if (!value) {
					controller.abort(new Error("Codex login cancelled"));
					throw new Error("Codex login cancelled");
				}
				return value;
			},
		});
	} finally {
		clearTimeout(timeout);
		controller.abort();
	}
}

export function parseAccountName(
	input: string,
): { ok: true; name: string } | { ok: false; error: string } {
	const name = input.trim();
	if (!ACCOUNT_NAME_RE.test(name))
		return {
			ok: false,
			error:
				"Account names must be 1-64 characters using letters, numbers, dot, underscore, or hyphen.",
		};
	return { ok: true, name };
}
function validName(input: string): string {
	const parsed = parseAccountName(input);
	if (!parsed.ok) throw new Error(parsed.error);
	if (
		["default", "builtin", "--default", DEFAULT_PI_LOGIN_LABEL].includes(
			parsed.name.toLowerCase(),
		)
	)
		throw new Error(
			"That name is reserved for default/built-in account selection.",
		);
	return parsed.name;
}
export function completeStoredAccountArguments(
	prefix: string,
	store: CodexAccountStore,
	options: { includeDefault?: boolean } = {},
): CommandArgumentCompletion[] {
	try {
		const items = Object.keys(store.read().accounts)
			.sort()
			.map((name) => ({ value: name, label: name }));
		if (options.includeDefault !== false)
			items.unshift(
				{ value: "default", label: "Global default (this session only)" },
				{ value: "builtin", label: DEFAULT_PI_LOGIN_LABEL },
			);
		return items.filter((item) => item.value.startsWith(prefix.trim()));
	} catch {
		return [];
	}
}
export function isOpenAICodexModel(
	model: { provider?: string } | undefined,
): boolean {
	return model?.provider === CODEX_PROVIDER_ID;
}
function isBuiltinArg(value: string): boolean {
	return value === "builtin" || value === DEFAULT_PI_LOGIN_LABEL;
}
function ownCredential(
	accounts: Record<string, StoredCodexCredential>,
	name: string,
): StoredCodexCredential | undefined {
	return Object.hasOwn(accounts, name) ? accounts[name] : undefined;
}
function sameCredential(
	current: StoredCodexCredential | undefined,
	expected: StoredCodexCredential,
): boolean {
	return (
		!!current &&
		current.access === expected.access &&
		current.refresh === expected.refresh &&
		current.expires === expected.expires &&
		current.accountId === expected.accountId
	);
}
export function parseStoredData(raw: string | undefined): CodexAccountsData {
	if (!raw?.trim()) return { accounts: {} };
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(
			"Invalid Codex accounts JSON; no credentials were changed.",
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("Codex accounts data must be an object.");
	const rawDefault = Object.hasOwn(parsed, "default")
		? parsed.default
		: parsed.active;
	let defaultName: string | undefined;
	if (rawDefault !== undefined && rawDefault !== null) {
		if (typeof rawDefault !== "string" || !parseAccountName(rawDefault).ok)
			throw new Error("Invalid global Codex default name.");
		defaultName = rawDefault;
	}
	const accounts: Record<string, StoredCodexCredential> = {};
	if (parsed.accounts !== undefined) {
		if (
			!parsed.accounts ||
			typeof parsed.accounts !== "object" ||
			Array.isArray(parsed.accounts)
		)
			throw new Error("Codex accounts must be an object.");
		for (const [name, value] of Object.entries(parsed.accounts)) {
			if (!parseAccountName(name).ok)
				throw new Error("Invalid saved Codex account name.");
			Object.defineProperty(accounts, name, {
				value: normalizeCredential(value),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
	}
	return {
		...(defaultName !== undefined ? { default: defaultName } : {}),
		accounts,
	};
}
function stringifyStoredData(data: CodexAccountsData): string {
	const normalized = parseStoredData(JSON.stringify(data));
	// Older processes read ONLY `active` and discard `default` when writing.
	// Mirror the global default on disk so both generations survive each
	// other's refresh writes. This is never the session-selected account.
	return `${JSON.stringify({ ...normalized, active: normalized.default }, null, 2)}\n`;
}
function normalizeCredential(value: unknown): StoredCodexCredential {
	const raw = value as Partial<StoredCodexCredential> | undefined;
	if (
		!raw ||
		typeof raw.access !== "string" ||
		!raw.access ||
		typeof raw.refresh !== "string" ||
		!raw.refresh ||
		typeof raw.expires !== "number" ||
		!Number.isFinite(raw.expires)
	)
		throw new Error(
			"Invalid Codex credential fields; no credentials were changed.",
		);
	return {
		access: raw.access,
		refresh: raw.refresh,
		expires: raw.expires,
		...(typeof raw.accountId === "string" && raw.accountId
			? { accountId: raw.accountId }
			: {}),
	};
}
function editDistance(left: string, right: string): number {
	let row = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let i = 1; i <= left.length; i++) {
		const next = [i];
		for (let j = 1; j <= right.length; j++)
			next[j] = Math.min(
				row[j] + 1,
				next[j - 1] + 1,
				row[j - 1] + Number(left[i - 1] !== right[j - 1]),
			);
		row = next;
	}
	return row[right.length];
}
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function redactTokenText(text: string): string {
	return text
		.replace(/Bearer\s+[^\s]+/gi, "Bearer <redacted>")
		.replace(/\beyJ[A-Za-z0-9._-]+/g, "<redacted>")
		.replace(/\brt\.[A-Za-z0-9._-]+/g, "<redacted>");
}
function redactCredentialError(
	error: unknown,
	credential: StoredCodexCredential,
): string {
	let text = errorMessage(error);
	for (const secret of [credential.access, credential.refresh])
		text = text.split(secret).join("<redacted>");
	return redactTokenText(text);
}
