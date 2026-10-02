import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import codexAccounts, {
	CodexAccountStore,
	ensureActiveCodexAuth,
	FAIL_CLOSED_API_KEY,
	parseStoredData,
	refreshStoredAccounts,
} from "../src/codex-accounts.js";
import type { CodexOAuthProvider } from "../src/oauth.js";
import {
	ACCOUNT_STATE_TYPE,
	restoreAccountSelection,
} from "../src/session-state.js";
import {
	FileCodexAccountStorageBackend,
	InMemoryCodexAccountStorageBackend,
} from "../src/storage.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const credential = (name: string, expires = Date.now() + 3_600_000) => ({
	access: `access-${name}`,
	refresh: `refresh-${name}`,
	expires,
	accountId: `id-${name}`,
});
const provider: CodexOAuthProvider = {
	getApiKey: (c) => c.access,
	refreshToken: async (c) => ({
		...c,
		access: `${c.access}-fresh`,
		refresh: `${c.refresh}-fresh`,
		expires: Date.now() + 3_600_000,
	}),
	login: async () => credential("plus"),
};
function context(id = "session-a") {
	const entries: any[] = [];
	const notices: string[] = [];
	const statuses = new Map();
	const tokens = new Map<string, string>();
	const ctx = {
		model: { provider: "openai-codex", id: "test" },
		hasUI: true,
		sessionManager: {
			getSessionId: () => id,
			getBranch: () => entries,
			getEntries: () => entries,
		},
		modelRegistry: {
			setRuntimeApiKey: (_id: string, value: string) => tokens.set(_id, value),
			removeRuntimeApiKey: (name: string) => tokens.delete(name),
			getApiKeyForProvider: async (name: string) => tokens.get(name),
		},
		ui: {
			notify: (text: string) => notices.push(text),
			setStatus: (name: string, text: string) => statuses.set(name, text),
			confirm: async () => false,
			select: async () => undefined,
		},
	};
	return {
		ctx: ctx as unknown as ExtensionContext,
		entries,
		notices,
		tokens,
		statuses,
	};
}
function harness(
	env: ReturnType<typeof context>,
	store: CodexAccountStore,
	oauth = provider,
) {
	const commands = new Map<string, any>();
	const handlers = new Map<string, any>();
	const events: any[] = [];
	const pi = {
		appendEntry: (customType: string, data: unknown) =>
			env.entries.push({ type: "custom", customType, data }),
		registerCommand: (name: string, command: any) =>
			commands.set(name, command),
		on: (event: string, handler: any) => handlers.set(event, handler),
		events: {
			emit: (event: string, data: unknown) => events.push([event, data]),
		},
	};
	codexAccounts(pi as unknown as ExtensionAPI, { store, oauthProvider: oauth });
	return {
		commands,
		events,
		fire: (event: string, data = {}) => handlers.get(event)?.(data, env.ctx),
		command: (name: string, args = "") =>
			commands.get(name).handler(args, env.ctx),
	};
}
async function storeWith(
	data: unknown,
	backend = new InMemoryCodexAccountStorageBackend(),
) {
	const store = new CodexAccountStore(backend);
	await store.writeRawForTest(JSON.stringify(data));
	return store;
}

test("regression: global-default equality rejects a valid session account; new sync terminates", async () => {
	const plus = credential("plus");
	const data = {
		default: "teams",
		accounts: { plus, teams: credential("teams") },
	};
	// This exact predicate in preserved activeCredentialMatches was the
	// missing infinite-retry trigger, even after fixing the refresh guard.
	const legacyMatch =
		data.default === "plus" && data.accounts.plus.access === plus.access;
	assert.equal(legacyMatch, false);
	const store = await storeWith(data);
	let calls = 0;
	const result = await ensureActiveCodexAuth(context().ctx, store, {
		accountName: "plus",
		oauthProvider: {
			...provider,
			getApiKey: (c) => {
				calls++;
				assert.ok(calls < 4, "unbounded retry");
				return c.access;
			},
		},
	});
	assert.deepEqual(result, { status: "active", accountName: "plus" });
	assert.equal(calls, 1);
	assert.equal(store.read().default, "teams");
});

test("bounded retries fail closed on constantly changing credentials, never recurse", async () => {
	const store = await storeWith({
		default: "teams",
		accounts: { plus: credential("plus") },
	});
	let calls = 0;
	const env = context();
	const result = await ensureActiveCodexAuth(env.ctx, store, {
		accountName: "plus",
		oauthProvider: {
			...provider,
			getApiKey: async (c) => {
				calls++;
				await store.update((data) => ({
					...data,
					accounts: { plus: { ...c, access: `${c.access}-${calls}` } },
				}));
				return c.access;
			},
		},
	});
	assert.equal(calls, 3);
	assert.equal(result.status, "error");
	assert.equal(env.tokens.get("openai-codex"), FAIL_CLOSED_API_KEY);
});

test("switch is session-only, no shared writer, and reload/resume restore selection", async () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-session-test-"));
	try {
		const path = join(dir, "accounts.json");
		const raw = JSON.stringify({
			active: "teams",
			accounts: { plus: credential("plus"), teams: credential("teams") },
		});
		writeFileSync(path, raw);
		mkdirSync(`${path}.lock`); // Deliberate lock: startup and switches must not touch it.
		const env = context();
		const store = new CodexAccountStore(
			new FileCodexAccountStorageBackend(path),
		);
		let app = harness(env, store);
		const before = statSync(path).mtimeMs;
		await app.fire("session_start");
		await app.command("codex-account", "plus");
		assert.equal(readFileSync(path, "utf8"), raw);
		assert.equal(statSync(path).mtimeMs, before);
		assert.equal(existsSync(`${path}.lock`), true);
		assert.equal(env.tokens.get("openai-codex"), "access-plus");
		assert.equal(restoreAccountSelection(env.entries)?.accountName, "plus");
		await app.fire("session_shutdown", { reason: "reload" });
		app = harness(env, store);
		await app.fire("session_start", { reason: "reload" });
		assert.equal(env.tokens.get("openai-codex"), "access-plus");
		assert.equal(readFileSync(path, "utf8"), raw);
		assert.ok(app.events.length);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("two sessions remain isolated through switches, default changes, and reload", async () => {
	const store = await storeWith({
		active: "teams",
		accounts: { teams: credential("teams"), plus: credential("plus") },
	});
	const a = context("a"),
		b = context("b");
	const aa = harness(a, store),
		bb = harness(b, store);
	await aa.fire("session_start");
	await bb.fire("session_start");
	await aa.command("codex-account", "plus");
	await aa.command("codex-default", "plus");
	await bb.fire("model_select", { model: b.ctx.model });
	assert.equal(a.tokens.get("openai-codex"), "access-plus");
	assert.equal(b.tokens.get("openai-codex"), "access-teams");
	const resumed = harness(b, store);
	await resumed.fire("session_start", { reason: "reload" });
	assert.equal(b.tokens.get("openai-codex"), "access-teams");
	assert.equal(store.read().default, "plus");
	assert.equal("sessionAccounts" in store.read(), false);
});

test("concurrent expired-account refresh rechecks under lock and rotates once", async () => {
	const backend = new InMemoryCodexAccountStorageBackend();
	const a = await storeWith(
		{
			default: "teams",
			accounts: { plus: credential("plus", 0), teams: credential("teams") },
		},
		backend,
	);
	const b = new CodexAccountStore(backend);
	let refreshes = 0;
	const oauth = {
		...provider,
		refreshToken: async (c: any) => {
			refreshes++;
			assert.equal(c.refresh, "refresh-plus");
			await sleep(10);
			return {
				...c,
				access: "rotated-access",
				refresh: "rotated-refresh",
				expires: Date.now() + 3_600_000,
			};
		},
	};
	const [ra, rb] = await Promise.all([
		ensureActiveCodexAuth(context("a").ctx, a, {
			accountName: "plus",
			oauthProvider: oauth,
		}),
		ensureActiveCodexAuth(context("b").ctx, b, {
			accountName: "plus",
			oauthProvider: oauth,
		}),
	]);
	assert.equal(refreshes, 1);
	assert.equal(ra.status, "active");
	assert.equal(rb.status, "active");
	assert.equal(b.read().accounts.plus.refresh, "rotated-refresh");
});

test("background and active refresh share the same serialized transaction", async () => {
	const backend = new InMemoryCodexAccountStorageBackend();
	const a = await storeWith(
		{ default: "teams", accounts: { plus: credential("plus", 0) } },
		backend,
	);
	const b = new CodexAccountStore(backend);
	let calls = 0;
	const oauth = {
		...provider,
		refreshToken: async (c: any) => {
			calls++;
			await sleep(10);
			return provider.refreshToken(c);
		},
	};
	await Promise.all([
		refreshStoredAccounts(a, { oauthProvider: oauth }),
		ensureActiveCodexAuth(context().ctx, b, {
			accountName: "plus",
			oauthProvider: oauth,
		}),
	]);
	assert.equal(calls, 1);
});

test("expired startup and non-Codex events neither refresh nor write", async () => {
	const store = await storeWith({
		default: "plus",
		accounts: { plus: credential("plus", 0) },
	});
	let refreshes = 0;
	const oauth = {
		...provider,
		refreshToken: async (c: any) => {
			refreshes++;
			return provider.refreshToken(c);
		},
	};
	const env = context();
	(env.ctx as any).model.provider = "zai";
	const app = harness(env, store, oauth);
	await app.fire("session_start");
	await app.fire("model_select", { model: env.ctx.model });
	await app.fire("before_agent_start");
	assert.equal(refreshes, 0);
	assert.equal(store.read().accounts.plus.expires, 0);
});

test("missing selected account never silently changes another session or default", async () => {
	const store = await storeWith({
		default: "teams",
		accounts: { teams: credential("teams") },
	});
	const env = context();
	const result = await ensureActiveCodexAuth(env.ctx, store, {
		accountName: "plus",
		oauthProvider: provider,
	});
	assert.equal(result.status, "error");
	assert.equal(store.read().default, "teams");
	assert.equal(env.tokens.get("openai-codex"), FAIL_CLOSED_API_KEY);
});

test("brand-new and close-match names require confirmation before opening auth", async () => {
	const store = await storeWith({
		default: "teams",
		accounts: { teams: credential("teams") },
	});
	const env = context();
	let calls = 0,
		confirms = 0;
	(env.ctx as any).ui.confirm = async () => {
		confirms++;
		return false;
	};
	const app = harness(env, store, {
		...provider,
		login: async () => {
			calls++;
			return credential("teams");
		},
	});
	await app.command("codex-login", "team");
	await app.command("codex-login", "test");
	assert.equal(confirms, 2);
	assert.equal(calls, 0);
	assert.deepEqual(Object.keys(store.read().accounts), ["teams"]);
});

test("same account under a new name updates canonical entry without deletion", async () => {
	const store = await storeWith({
		default: "plus",
		accounts: { plus: credential("plus"), teams: credential("teams") },
	});
	const env = context();
	(env.ctx as any).ui.confirm = async () => true;
	const app = harness(env, store, {
		...provider,
		login: async () => credential("teams"),
	});
	await app.fire("session_start");
	await app.command("codex-login", "test");
	assert.deepEqual(Object.keys(store.read().accounts), ["plus", "teams"]);
	assert.equal(store.read().default, "plus");
	assert.equal(restoreAccountSelection(env.entries)?.accountName, "teams");
	assert.equal(env.tokens.get("openai-codex"), "access-teams");
});

test("legacy/new schema reads without side effects; session map never becomes internal state", async () => {
	const backend = new InMemoryCodexAccountStorageBackend();
	const store = await storeWith(
		{
			active: "plus",
			sessionAccounts: { stale: "teams" },
			accounts: { plus: credential("plus") },
		},
		backend,
	);
	assert.equal(store.read().default, "plus");
	await store.update((data) => ({ ...data, default: "plus" }));
	assert.equal(JSON.parse(backend.readRaw() ?? "{}").active, "plus");
	assert.equal("active" in store.read(), false);
	assert.equal("sessionAccounts" in store.read(), false);
	assert.equal(
		parseStoredData('{"default":null,"active":"plus","accounts":{}}').default,
		undefined,
	);
});

test("missing lockless read creates no directory or file", () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-read-"));
	try {
		const path = join(dir, "missing", "accounts.json");
		assert.equal(new FileCodexAccountStorageBackend(path).readRaw(), undefined);
		assert.equal(existsSync(join(dir, "missing")), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
