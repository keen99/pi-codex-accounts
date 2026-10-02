import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import {
	CodexAccountStore,
	parseStoredData,
	refreshStoredAccounts,
} from "../src/codex-accounts.js";
import { InMemoryCodexAccountStorageBackend } from "../src/storage.js";

// Execute the saved legacy reader/writer, not a guessed approximation.
const fixture = readFileSync(
	new URL("./fixtures/legacy-schema.ts", import.meta.url),
	"utf8",
);
const code = stripTypeScriptTypes(fixture).replace(
	"export function",
	"function",
);
const legacy = new Function(
	`${code}; return { read: parseStoredData, write: stringifyStoredData };`,
)() as {
	read: (raw: string | undefined) => {
		active?: string;
		accounts: Record<string, ReturnType<typeof credential>>;
	};
	write: (data: unknown) => string;
};
function credential(name: string, expires = Date.now() + 3_600_000) {
	return {
		access: `access-${name}`,
		refresh: `refresh-${name}`,
		expires,
		accountId: `id-${name}`,
	};
}

test("new refresh preserves legacy active=global default, never session-selected account", async () => {
	const backend = new InMemoryCodexAccountStorageBackend();
	const store = new CodexAccountStore(backend);
	const raw = JSON.stringify({
		active: "teams",
		accounts: { teams: credential("teams"), plus: credential("plus", 0) },
	});
	await store.writeRawForTest(raw);
	assert.equal(store.read().default, "teams");
	assert.equal(backend.readRaw(), raw); // A read does not migrate anything.
	await refreshStoredAccounts(store, {
		oauthProvider: {
			getApiKey: (c) => c.access,
			refreshToken: async (c) => ({
				...c,
				access: "rotated-plus",
				refresh: "rotated-refresh",
				expires: Date.now() + 3_600_000,
			}),
		},
	});
	const written = JSON.parse(backend.readRaw() ?? "{}");
	assert.equal(written.active, "teams");
	assert.equal(written.default, "teams");
	const old = legacy.read(backend.readRaw());
	assert.equal(old.active, "teams");
	assert.equal(old.accounts.teams.access, "access-teams");
	assert.equal(old.accounts.plus.access, "rotated-plus");
});

test("legacy refresh drops default field, but new reader retains global default via active mirror", async () => {
	const backend = new InMemoryCodexAccountStorageBackend();
	const store = new CodexAccountStore(backend);
	await store.write({
		default: "teams",
		accounts: { teams: credential("teams"), plus: credential("plus") },
	});
	const old = legacy.read(backend.readRaw());
	old.accounts.plus = credential("legacy-rotated-plus");
	await store.writeRawForTest(legacy.write(old));
	assert.equal(
		Object.hasOwn(JSON.parse(backend.readRaw() ?? "{}"), "default"),
		false,
	);
	assert.equal(store.read().default, "teams");
	assert.equal(store.read().accounts.plus.access, "access-legacy-rotated-plus");
	await store.update((data) => ({
		...data,
		accounts: { ...data.accounts, plus: credential("new-rotated-plus") },
	}));
	assert.equal(legacy.read(backend.readRaw()).active, "teams");
	assert.equal(
		legacy.read(backend.readRaw()).accounts.plus.access,
		"access-new-rotated-plus",
	);
});

test("explicit global-default changes mirror active; clearing default clears both generations", async () => {
	const backend = new InMemoryCodexAccountStorageBackend();
	const store = new CodexAccountStore(backend);
	await store.write({
		default: "teams",
		accounts: { teams: credential("teams"), plus: credential("plus") },
	});
	await store.update((data) => ({ ...data, default: "plus" }));
	assert.equal(legacy.read(backend.readRaw()).active, "plus");
	assert.equal(store.read().default, "plus");
	await store.update((data) => ({ ...data, default: undefined }));
	assert.equal(legacy.read(backend.readRaw()).active, undefined);
	assert.equal(store.read().default, undefined);
	assert.deepEqual(Object.keys(store.read().accounts).sort(), [
		"plus",
		"teams",
	]);
});

test("default-only file repair is explicit; no-op reads/transactions remain side-effect-free", async () => {
	const backend = new InMemoryCodexAccountStorageBackend();
	const store = new CodexAccountStore(backend);
	const raw = JSON.stringify({
		default: "teams",
		accounts: { teams: credential("teams") },
	});
	await store.writeRawForTest(raw);
	await store.update((data) => data);
	assert.equal(backend.readRaw(), raw);
	assert.equal(legacy.read(backend.readRaw()).active, undefined);
	// Same transaction as /codex-default teams: deliberate shared-file write.
	await store.update((data) => ({ ...data, default: "teams" }));
	assert.equal(legacy.read(backend.readRaw()).active, "teams");
	assert.equal(parseStoredData(backend.readRaw()).default, "teams");
});
