import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";

// Execute the ACTUAL saved branch's auth function with a bounded store double.
// The old recursive path is cut off after ten reads, so this cannot freeze pi
// or the test runner. No config files, real credentials, or network are used.
test("preserved auth loop reproduces hot recursion when session account differs from default", async () => {
	const fixture = readFileSync(new URL("./fixtures/legacy-auth-loop.ts", import.meta.url), "utf8");
	const js = stripTypeScriptTypes(fixture).replace("export async function", "async function");
	const create = new Function("captureRuntimeOverride", "getOwnStoredAccount", "clearRuntimeCodexAuth", "setRuntimeCodexApiKey", "REFRESH_SKEW_MS", `${js}; return ensureActiveCodexAuth;`);
	const oldSync = create(() => undefined, (accounts: any, name: string) => accounts[name], async () => undefined, async () => true, 300_000);
	const plus = { access: "access-plus", refresh: "refresh-plus", expires: Date.now() + 3_600_000 };
	const data = { default: "teams", sessionAccounts: { session: "plus" }, accounts: { plus } };
	let reads = 0, keys = 0;
	const store = { readAsync: async () => {
		reads++;
		if (reads > 10) throw new Error("REPRO: stopped hot recursion after ten reads");
		return data;
	} };
	await assert.rejects(oldSync({}, store, { sessionId: "session", oauthProvider: {
		getApiKey: async () => { keys++; return plus.access; },
	} }), /stopped hot recursion/);
	assert.equal(reads, 11); assert.equal(keys, 5);
});
