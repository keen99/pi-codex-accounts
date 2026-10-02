import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import codexAccounts, { CodexAccountStore } from "../src/codex-accounts.js";
import { InMemoryCodexAccountStorageBackend } from "../src/storage.js";
import { restoreAccountSelection, type StateEntry } from "../src/session-state.js";

// A superseded sync may finish later, but must never overwrite the new token,
// status, selection, or success notification.
test("late completion of an earlier switch cannot override latest session choice", async () => {
	const store = new CodexAccountStore(new InMemoryCodexAccountStorageBackend());
	const credential = (name: string) => ({ access: name, refresh: name, expires: Date.now() + 3_600_000 });
	await store.write({ default: "plus", accounts: { plus: credential("plus"), teams: credential("teams") } });
	const entries: StateEntry[] = [];
	const notices: string[] = [];
	let token: string | undefined;
	let release!: () => void, started!: () => void;
	const ready = new Promise<void>((resolve) => { started = resolve; });
	const waiting = new Promise<void>((resolve) => { release = resolve; });
	const ctx = {
		model: { provider: "openai-codex" }, hasUI: true,
		sessionManager: { getSessionId: () => "concurrent", getBranch: () => entries },
		modelRegistry: { setRuntimeApiKey: (_provider: string, key: string) => { token = key; },
			removeRuntimeApiKey: () => { token = undefined; }, getApiKeyForProvider: async () => token },
		ui: { notify: (text: string) => notices.push(text), setStatus: () => undefined },
	} as unknown as ExtensionCommandContext;
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	let init!: (event: unknown, ctx: ExtensionCommandContext) => Promise<void>;
	const pi = {
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: (name: string, handler: any) => { if (name === "session_start") init = handler; },
		events: { emit: () => undefined },
	} as unknown as ExtensionAPI;
	codexAccounts(pi, { store, oauthProvider: {
		login: async () => credential("plus"), refreshToken: async (c) => c,
		getApiKey: async (c) => {
			if (c.access === "teams") { started(); await waiting; }
			return c.access;
		},
	} });
	await init({}, ctx);
	const first = commands.get("codex-account")!.handler("teams", ctx);
	await ready;
	await commands.get("codex-account")!.handler("plus", ctx);
	release(); await first;
	assert.equal(token, "plus");
	assert.equal(restoreAccountSelection(entries)?.accountName, "plus");
	assert.ok(!notices.some((text) => text.startsWith('Activated Codex account "teams"')));
});
