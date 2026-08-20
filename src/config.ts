import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const CONFIG_FILE = "codex-accounts-config.json";

export type AutoSwitchConfig = {
	/** Master toggle. Default false — opt-in only. */
	autoSwitch: boolean;
	/** How long an account is skipped after a 429 (ms). */
	cooldownMs: number;
	/** Minimum time between auto-switches (ms), anti-thrash. */
	minSwitchIntervalMs: number;
};

export const DEFAULT_AUTO_SWITCH_CONFIG: AutoSwitchConfig = {
	autoSwitch: false,
	cooldownMs: 30 * 60 * 1000,
	minSwitchIntervalMs: 5 * 60 * 1000,
};

const MIN_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MIN_SWITCH_INTERVAL_MS = 0;
const MAX_SWITCH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function loadAutoSwitchConfig(
	agentDir: string = getAgentDir(),
): AutoSwitchConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(join(agentDir, CONFIG_FILE), "utf8"));
	} catch {
		return { ...DEFAULT_AUTO_SWITCH_CONFIG };
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { ...DEFAULT_AUTO_SWITCH_CONFIG };
	}
	const value = raw as Record<string, unknown>;
	return {
		autoSwitch: booleanValue(
			value.autoSwitch,
			DEFAULT_AUTO_SWITCH_CONFIG.autoSwitch,
		),
		cooldownMs: boundedNumber(
			value.cooldownMs,
			DEFAULT_AUTO_SWITCH_CONFIG.cooldownMs,
			MIN_COOLDOWN_MS,
			MAX_COOLDOWN_MS,
		),
		minSwitchIntervalMs: boundedNumber(
			value.minSwitchIntervalMs,
			DEFAULT_AUTO_SWITCH_CONFIG.minSwitchIntervalMs,
			MIN_SWITCH_INTERVAL_MS,
			MAX_SWITCH_INTERVAL_MS,
		),
	};
}

function booleanValue(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function boundedNumber(
	value: unknown,
	fallback: number,
	min: number,
	max: number,
): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(min, Math.min(max, Math.round(value)))
		: fallback;
}
