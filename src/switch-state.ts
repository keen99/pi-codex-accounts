import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { FileCodexAccountStorageBackend } from "./storage.js";

export const SWITCH_STATE_FILE = "codex-accounts-switch-state.json";

/** Maps account name → epoch ms until which the account is considered exhausted. */
export type SwitchState = Record<string, number>;

type StorageLockResult<T> = { result: T; next?: string };

export class SwitchStateStore {
	constructor(
		private readonly backend: {
			withLockAsync<T>(
				mutator: (current: string | undefined) => Promise<StorageLockResult<T>>,
			): Promise<T>;
		} = new FileCodexAccountStorageBackend(defaultStatePath()),
	) {}

	async read(): Promise<SwitchState> {
		return this.backend.withLockAsync(async (current) => {
			if (!current) return { result: {} };
			const parsed = parseState(current);
			return parsed === undefined ? { result: {} } : { result: parsed };
		});
	}

	async markExhausted(
		name: string,
		untilMs: number,
		now = Date.now(),
	): Promise<void> {
		await this.mutate((state, currentNow) => {
			const existing = state[name] ?? 0;
			const max = Math.max(existing, untilMs);
			if (max <= currentNow) return state;
			return { ...state, [name]: max };
		}, now);
	}

	async pruneExpired(now = Date.now()): Promise<SwitchState> {
		return this.mutate((state, currentNow) => {
			const next: SwitchState = {};
			let changed = false;
			for (const [name, until] of Object.entries(state)) {
				if (until > currentNow) next[name] = until;
				else changed = true;
			}
			return changed ? next : state;
		}, now);
	}

	private async mutate(
		mutator: (state: SwitchState, now: number) => SwitchState,
		now: number,
	): Promise<SwitchState> {
		return this.backend.withLockAsync(async (current) => {
			const state = parseState(current ?? "") ?? {};
			const next = mutator(state, now);
			return { result: next, next: `${JSON.stringify(next, null, 2)}\n` };
		});
	}
}

function parseState(raw: string): SwitchState | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const state: SwitchState = {};
	for (const [name, until] of Object.entries(
		value as Record<string, unknown>,
	)) {
		if (typeof until === "number" && Number.isFinite(until))
			state[name] = until;
	}
	return state;
}

function defaultStatePath(): string {
	return join(getAgentDir(), SWITCH_STATE_FILE);
}
