// Exact legacy reader/writer from 223c14a. Test-only schema compatibility fixture.
const ACCOUNT_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
export function parseAccountName(
	input: string,
): { ok: true; name: string } | { ok: false; error: string } {
	const name = input.trim();
	if (!name) return { ok: false, error: "Account name is required." };
	if (!ACCOUNT_NAME_RE.test(name)) {
		return {
			ok: false,
			error:
				"Account names must be 1-64 characters using letters, numbers, dot, underscore, or hyphen.",
		};
	}
	return { ok: true, name };
}

function parseStoredData(raw: string | undefined): CodexAccountsData {
	if (!raw?.trim()) return { accounts: {} };

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		throw new Error(
			`Invalid Codex accounts JSON. Fix or remove ${CODEX_ACCOUNTS_FILE}.`,
		);
	}

	if (!isRecord(parsed))
		throw new Error("Invalid Codex accounts data: expected an object.");
	const accounts = parseAccounts(parsed.accounts);
	const active = parseActiveAccount(parsed.active);
	return active ? { active, accounts } : { accounts };
}

function getOwnStoredAccount(
	accounts: Record<string, StoredCodexCredential>,
	name: string,
): StoredCodexCredential | undefined {
	return Object.hasOwn(accounts, name) ? accounts[name] : undefined;
}

function parseAccounts(
	rawAccounts: unknown,
): Record<string, StoredCodexCredential> {
	if (rawAccounts === undefined) return {};
	if (!isRecord(rawAccounts))
		throw new Error("Invalid Codex accounts data: accounts must be an object.");

	const accounts: Record<string, StoredCodexCredential> = {};
	for (const [name, rawCredential] of Object.entries(rawAccounts)) {
		const parsedName = parseAccountName(name);
		if (!parsedName.ok)
			throw new Error(
				`Invalid Codex accounts data: bad account name "${name}".`,
			);
		Object.defineProperty(accounts, name, {
			configurable: true,
			enumerable: true,
			value: normalizeCredential(rawCredential, name),
			writable: true,
		});
	}
	return accounts;
}

function parseActiveAccount(rawActive: unknown): string | undefined {
	if (rawActive === undefined || rawActive === null) return undefined;
	if (typeof rawActive !== "string") {
		throw new Error("Invalid Codex accounts data: active must be a string.");
	}
	const parsed = parseAccountName(rawActive);
	if (!parsed.ok)
		throw new Error(
			"Invalid Codex accounts data: active account name is invalid.",
		);
	return parsed.name;
}

function stringifyStoredData(data: CodexAccountsData): string {
	return `${JSON.stringify(parseStoredData(JSON.stringify(data)), null, 2)}\n`;
}

function normalizeCredential(
	rawCredential: unknown,
	accountName = "account",
): StoredCodexCredential {
	if (!isRecord(rawCredential)) {
		throw new Error(
			`Invalid Codex accounts data: ${accountName} credential must be an object.`,
		);
	}
	if (typeof rawCredential.access !== "string" || !rawCredential.access) {
		throw new Error(
			`Invalid Codex accounts data: ${accountName} credential is missing access token.`,
		);
	}
	if (typeof rawCredential.refresh !== "string" || !rawCredential.refresh) {
		throw new Error(
			`Invalid Codex accounts data: ${accountName} credential is missing refresh token.`,
		);
	}
	if (
		typeof rawCredential.expires !== "number" ||
		!Number.isFinite(rawCredential.expires)
	) {
		throw new Error(
			`Invalid Codex accounts data: ${accountName} credential has invalid expiration.`,
		);
	}
	const accountId =
		typeof rawCredential.accountId === "string"
			? rawCredential.accountId
			: undefined;
	return accountId
		? {
				access: rawCredential.access,
				refresh: rawCredential.refresh,
				expires: rawCredential.expires,
				accountId,
			}
		: {
				access: rawCredential.access,
				refresh: rawCredential.refresh,
				expires: rawCredential.expires,
			};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
