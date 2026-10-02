// Regression fixture: exact preserved auth loop (0a4f8f6). Test-only; bounded read stub stops it.
export async function ensureActiveCodexAuth(
	ctx: ExtensionContext,
	store: CodexAccountStore,
	options: {
		oauthProvider?: RefreshOnlyCodexOAuthProvider;
		now?: number;
		/** Session id whose per-session account override takes precedence over global `active`. */
		sessionId?: string;
	} = {},
): Promise<EnsureActiveCodexAuthResult> {
	const runtimeOverride = captureRuntimeOverride(ctx);
	const data = await store.readAsync();
	const sessionAccount = options.sessionId
		? data.sessionAccounts?.[options.sessionId]
		: undefined;
	const sessionCredential = sessionAccount
		? getOwnStoredAccount(data.accounts, sessionAccount)
		: undefined;
	const active = sessionCredential ? sessionAccount : data.default;
	// Re-resolve the active pointer against a latest store snapshot. Session
	// overrides mean `default` is NOT the same as `active` — comparing them
	// directly caused an infinite recursion (100% CPU TUI freeze).
	const resolveActive = (d: {
		default?: string;
		sessionAccounts?: Record<string, string>;
		accounts: Record<string, StoredCodexCredential>;
	}): string | undefined => {
		const s = options.sessionId
			? d.sessionAccounts?.[options.sessionId]
			: undefined;
		return s && getOwnStoredAccount(d.accounts, s) ? s : d.default;
	};
	if (!active) {
		await clearRuntimeCodexAuth(ctx);
		return { status: "inactive" };
	}

	let credential = getOwnStoredAccount(data.accounts, active);
	if (!credential) {
		const current = await store.update((latest) => {
			if (
				resolveActive(latest) !== active ||
				getOwnStoredAccount(latest.accounts, active)
			)
				return latest;
			// Resolved pointer is `default` itself and its account is gone — clear it.
			return { ...latest, default: undefined };
		});
		if (resolveActive(current))
			return ensureActiveCodexAuth(ctx, store, options);
		await clearRuntimeCodexAuth(ctx);
		return { status: "inactive" };
	}

	const oauthProvider =
		options.oauthProvider ?? getDefaultCodexOAuthProvider(CODEX_PROVIDER_ID);
	if (credential.expires <= (options.now ?? Date.now()) + REFRESH_SKEW_MS) {
		let refreshError: unknown;
		const current = await store.updateAsync(async (latest) => {
			const latestCredential = getOwnStoredAccount(latest.accounts, active);
			if (resolveActive(latest) !== active || !latestCredential) return latest;
			credential = latestCredential;
			if (
				latestCredential.expires >
				(options.now ?? Date.now()) + REFRESH_SKEW_MS
			) {
				return latest;
			}
			try {
				const refreshed = normalizeCredential(
					await Promise.race([
						oauthProvider.refreshToken(latestCredential),
						timeoutAfter(
							OAUTH_CALL_TIMEOUT_MS,
							"Codex token refresh timed out",
						),
					]),
				);
				credential = refreshed;
				return {
					...latest,
					accounts: { ...latest.accounts, [active]: refreshed },
				};
			} catch (error) {
				refreshError = error;
				return latest;
			}
		});
		if (
			resolveActive(current) !== active ||
			!getOwnStoredAccount(current.accounts, active)
		) {
			return ensureActiveCodexAuth(ctx, store, options);
		}
		if (refreshError !== undefined) {
			if (!(await activeCredentialMatches(store, active, credential))) {
				return ensureActiveCodexAuth(ctx, store, options);
			}
			if (
				!(await setRuntimeCodexApiKey(runtimeOverride, FAIL_CLOSED_API_KEY))
			) {
				return { status: "inactive" };
			}
			return {
				status: "error",
				accountName: active,
				message: redactCredentialError(refreshError, credential),
			};
		}
	}

	let apiKey: string;
	try {
		apiKey = await Promise.race([
			oauthProvider.getApiKey(credential),
			timeoutAfter(OAUTH_CALL_TIMEOUT_MS, "Codex API key exchange timed out"),
		]);
	} catch (error) {
		if (!(await activeCredentialMatches(store, active, credential))) {
			return ensureActiveCodexAuth(ctx, store, options);
		}
		if (!(await setRuntimeCodexApiKey(runtimeOverride, FAIL_CLOSED_API_KEY))) {
			return { status: "inactive" };
		}
		return {
			status: "error",
			accountName: active,
			message: redactCredentialError(error, credential),
		};
	}
	if (!(await activeCredentialMatches(store, active, credential))) {
		return ensureActiveCodexAuth(ctx, store, options);
	}
	if (!(await setRuntimeCodexApiKey(runtimeOverride, apiKey))) {
		return { status: "inactive" };
	}
	return { status: "active", accountName: active };
}

async function activeCredentialMatches(
	store: CodexAccountStore,
	accountName: string,
	expected: StoredCodexCredential,
): Promise<boolean> {
	const latest = await store.readAsync();
	const current = getOwnStoredAccount(latest.accounts, accountName);
	return (
		latest.default === accountName &&
		current !== undefined &&
		current.access === expected.access &&
		current.refresh === expected.refresh &&
		current.expires === expected.expires &&
		current.accountId === expected.accountId
	);
}
