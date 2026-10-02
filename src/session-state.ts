/** Versioned, non-secret session state; shared contract with pi-usage-status. */
export const ACCOUNT_STATE_TYPE = "codex-accounts/selection-v1";
export const ACCOUNT_CHANGED_EVENT = "codex-accounts:changed-v1";
export type AccountSelection = { accountName: string | null };
export type StateEntry = { type: string; customType?: string; data?: unknown };

export function restoreAccountSelection(
	entries: readonly StateEntry[],
): AccountSelection | undefined {
	let selection: AccountSelection | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== ACCOUNT_STATE_TYPE)
			continue;
		const data = entry.data as Partial<AccountSelection> | undefined;
		if (
			data &&
			(data.accountName === null || typeof data.accountName === "string")
		) {
			selection = { accountName: data.accountName };
		}
	}
	return selection;
}
