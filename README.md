# pi-codex-accounts

![release-watch](https://github.com/keen99/pi-codex-accounts/actions/workflows/release-watch.yml/badge.svg)
[![pi tested](https://img.shields.io/github/v/release/keen99/pi-codex-accounts?label=pi%20tested%200.75.0%20%E2%86%92)](https://github.com/keen99/pi-codex-accounts/releases)

Named ChatGPT Codex credentials with independent account selection for each pi session. Fork of `@narumitw/pi-codex-accounts`; keeps `codex-accounts.json` and `accountId` for usage reporting.

## Install

```bash
# ssh
pi install git:git@github.com:keen99/pi-codex-accounts

# https
pi install git:github.com/keen99/pi-codex-accounts
```

## Commands

| Command | Effect |
|---|---|
| `/codex-account` | Pick an account for **this session**. |
| `/codex-account plus` | Select plus for this session; does not write shared credentials or global default. |
| `/codex-account default` | Select the current global default for this session. |
| `/codex-account builtin` | Use pi's built-in Codex login for this session. |
| `/codex-default` | Show the global default. |
| `/codex-default teams` | Explicitly set the default for new sessions; existing sessions stay unchanged. |
| `/codex-default builtin` | Explicitly clear the named global default. |
| `/codex-account plus --default` | Explicitly set the global default and select plus in this session. |
| `/codex-login plus` | Re-login plus, store its credentials, and select it in this session. The global default is unchanged. |
| `/codex-logout plus` | Confirm removal of **shared credentials**; availability changes in all sessions. Their selections are not edited. |

Login completes in the browser while the visible input waits. Paste an authorization code or redirect URL if needed. **Escape cancels immediately**, closes that login's callback server, and leaves credentials/selection unchanged. Browser success closes the input without requiring any typing.

New local names require confirmation. A local name is not a new OpenAI subscription. Existing names autocomplete; case-insensitive matches reuse their canonical spelling. After authentication, an already-stored account ID uses the existing name instead of creating a duplicate. Old duplicate entries are not automatically deleted.

## Where state belongs

- **Credentials and global default:** `~/.pi/agent/codex-accounts.json`.
- **Session choice:** pi's normal `appendEntry("codex-accounts/selection-v1", {accountName})` custom session entry. No credentials are placed in the session entry. It does not enter LLM context.
- **Reload/resume:** restore selection from the current session branch.
- **New session:** pin its initial default once in its own session. Changing the global default later does not move that session.
- **Tree/fork:** selection follows the current branch's custom entries.

Shared-file example:

```json
{
  "default": "plus",
  "active": "plus",
  "accounts": {
    "plus": {
      "access": "...",
      "refresh": "...",
      "expires": 1800000000000,
      "accountId": "..."
    }
  }
}
```

Legacy `active` is read as the global default when `default` is absent. Every actual shared write mirrors `default` into `active` for older processes; this is **not** the current session's selection. Legacy refresh writers discard `default`, but retain `active`, so newer readers still recover the same global default. Reads and session switches do not migrate or rewrite anything. If an earlier default-only file needs repair, explicitly run `/codex-default <current-default>` once; do not alter credentials manually.

The abandoned shared `sessionAccounts` map is not used; session choices belong in pi sessions. On first upgrade, a session without a custom selection takes the configured default; select its intended account once. Old processes still use global `active` and can change it with their old switch command. Session isolation applies only after that process reloads the new extension.

Removing a selected account does not silently substitute another. Authentication fails closed with a clear notification until that session selects a valid account or built-in login.

## Locking and refresh

Reads are lockless and do not create files, directories, or lock entries. A missing file is an empty store. Shared writes use a bounded asynchronous lock acquisition and an atomic private temporary-file replacement. Unchanged transactions do not rewrite the file.

Refresh is serialized across processes: lock, reread, recheck expiry, complete the refresh request, persist rotated credentials, then release. A request deadline aborts the transport and awaits settlement; it never releases the lock while an abandoned refresh continues in the background.

Startup/model changes/switches do not refresh expired credentials or block on a write lock. The selected account is renewed before a Codex turn when needed. Other expired stored accounts are checked asynchronously after a completed turn, at most hourly. Non-Codex turns do not wait for Codex authentication.

Authentication state uses bounded concurrent-change retries, not recursive re-entry. The global default is never compared against a session-selected account to validate credentials.

## Login ownership

The extension owns its PKCE callback server, matching pi's Codex client ID and endpoints. It closes only its own server and sockets. It does not scan process handles, kill processes, or close another listener. An occupied callback port fails immediately with an explanation. Five minutes is an overall safety deadline, not the cancellation mechanism.

## Usage footer contract

`pi-usage-status` reads the same `codex-accounts/selection-v1` session entry and the new/legacy global-default schema. Changes emit `codex-accounts:changed-v1` on pi's shared event bus. The previously shipped optional global refresh hook remains for backward compatibility. No file watcher or shared session map is needed.

## Development

```sh
npm run check       # typecheck + 26 unit tests (oauth, storage, switching, refresh)
npm run test:matrix # deep RPC smoke on every published pi release >= 0.75.0
```

The matrix boots each pinned pi release in RPC mode and drives the full
smoke: load, account switch, auth, footer, reload, Escape cancellation,
credential preservation. Cached installs live in `.matrix-cache/` and
are reused across runs; new pi releases are picked up automatically.

`PI_TEST_BIN` overrides the pi binary in the smoke test.

## Development tests

```sh
npm run check       # strict typecheck, offline unit/server/multiprocess tests
npm run test:rpc    # real pi loader, runtime auth, footer, reload, login UI cancellation
```

RPC tests create an isolated agent directory and use synthetic credentials. All token/usage requests are mocked; callback tests use ephemeral ports. They never use real user configuration, accounts, or sessions. The smoke test uses `pi` alongside the current Node executable, avoiding npm's dev-dependency PATH override; set `PI_TEST_BIN` to another executable if needed. Verified against installed pi 0.75.4.

Offline tests are not proof of live OpenAI availability or successful real account authentication. Test live rollout separately before shipping.

MIT; see [LICENSE](LICENSE).
