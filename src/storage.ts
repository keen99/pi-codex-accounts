import { randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";

type StorageLockResult<T> = { result: T; next?: string };
export interface CodexAccountStorageBackend {
	readRaw(): string | undefined;
	withLockAsync<T>(
		mutator: (current: string | undefined) => Promise<StorageLockResult<T>>,
	): Promise<T>;
}

export class FileCodexAccountStorageBackend
	implements CodexAccountStorageBackend
{
	constructor(private readonly filePath: string) {}

	/** A missing file is an empty store. Reads never create files or locks. */
	readRaw(): string | undefined {
		try {
			return readFileSync(this.filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	async withLockAsync<T>(
		mutator: (current: string | undefined) => Promise<StorageLockResult<T>>,
	): Promise<T> {
		mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
		let compromised: Error | undefined;
		// Bound acquisition, not the transaction. In-flight refresh MUST settle
		// and persist before release; racing it against a timeout loses rotations.
		const release = await lockfile
			.lock(this.filePath, {
				realpath: false,
				retries: { retries: 4, factor: 2, minTimeout: 25, maxTimeout: 200 },
				stale: 30_000,
				onCompromised: (error: Error) => {
					compromised = error;
				},
			})
			.catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ELOCKED")
					throw new Error(
						"Codex credentials are locked by another writer. Retry shortly; no credentials were changed.",
					);
				throw error;
			});
		try {
			const current = this.readRaw();
			const { result, next } = await mutator(current);
			if (compromised) throw compromised;
			if (next !== undefined && next !== current) this.writeAtomic(next);
			return result;
		} finally {
			await release().catch(() => undefined);
		}
	}

	private writeAtomic(contents: string): void {
		const temporary = join(
			dirname(this.filePath),
			`.codex-accounts-${randomUUID()}.tmp`,
		);
		let descriptor: number | undefined;
		try {
			descriptor = openSync(temporary, "wx", 0o600);
			writeFileSync(descriptor, contents, "utf8");
			fsyncSync(descriptor);
			closeSync(descriptor);
			descriptor = undefined;
			renameSync(temporary, this.filePath);
		} finally {
			if (descriptor !== undefined) closeSync(descriptor);
			rmSync(temporary, { force: true });
		}
	}
}

export class InMemoryCodexAccountStorageBackend
	implements CodexAccountStorageBackend
{
	private value: string | undefined;
	private tail: Promise<unknown> = Promise.resolve();
	readRaw(): string | undefined {
		return this.value;
	}
	withLockAsync<T>(
		mutator: (current: string | undefined) => Promise<StorageLockResult<T>>,
	): Promise<T> {
		const operation = this.tail.then(async () => {
			const { result, next } = await mutator(this.value);
			if (next !== undefined) this.value = next;
			return result;
		});
		this.tail = operation.catch(() => undefined);
		return operation;
	}
}
