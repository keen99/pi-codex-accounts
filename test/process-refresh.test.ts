import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// These are test-owned child processes with synthetic credentials. Never
// inspect/signal any running user pi process or bind the real OAuth port.
test("independent processes refresh the same expired token exactly once", async () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-multiprocess-"));
	try {
		writeFileSync(
			join(dir, "accounts.json"),
			JSON.stringify({
				active: "plus",
				accounts: {
					plus: { access: "old-access", refresh: "old-refresh", expires: 0 },
				},
			}),
		);
		const runWorker = () =>
			new Promise<void>((resolve, reject) => {
				const child = fork(
					new URL("./refresh-worker.ts", import.meta.url),
					[dir],
					{
						execArgv: process.execArgv.filter((arg) => arg !== "--test"),
						stdio: ["ignore", "pipe", "pipe", "ipc"],
					},
				);
				let output = "";
				child.stderr?.on("data", (chunk) => {
					output += chunk;
				});
				child.on("error", reject);
				child.on("exit", (code) =>
					code === 0
						? resolve()
						: reject(new Error(`test worker exit ${code}: ${output}`)),
				);
			});
		await Promise.all([runWorker(), runWorker()]);
		assert.equal(
			readFileSync(join(dir, "requests.log"), "utf8").trim().split("\n").length,
			1,
		);
		const saved = JSON.parse(readFileSync(join(dir, "accounts.json"), "utf8"));
		assert.equal(saved.accounts.plus.refresh, "rotated-refresh");
		assert.equal(saved.default, "plus");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
