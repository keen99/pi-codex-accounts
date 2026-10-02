import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
	CodexAccountStore,
	refreshStoredAccounts,
} from "../src/codex-accounts.js";
import { FileCodexAccountStorageBackend } from "../src/storage.js";

const directory = process.argv[2];
const errors = await refreshStoredAccounts(
	new CodexAccountStore(
		new FileCodexAccountStorageBackend(join(directory, "accounts.json")),
	),
	{
		oauthProvider: {
			getApiKey: (credential) => credential.access,
			refreshToken: async (credential) => {
				appendFileSync(
					join(directory, "requests.log"),
					`${process.pid}:${credential.refresh}\n`,
				);
				await new Promise((resolve) => setTimeout(resolve, 70));
				return {
					...credential,
					access: "rotated-access",
					refresh: "rotated-refresh",
					expires: Date.now() + 3_600_000,
				};
			},
		},
	},
);
if (errors.size) throw new Error(JSON.stringify([...errors]));
