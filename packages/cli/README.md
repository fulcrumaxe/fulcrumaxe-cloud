# fulcrumaxe CLI

`fulcrumaxe` (alias `fx`) works with your account from a terminal, using a token made in the Developer app. This package is the core: sign in, sign out, and check who you are. Read commands (below) build on it.

```sh
printf '%s\n' "$TOKEN" | fx login --base-url https://<your fulcrumaxe address>   # the token is read from standard input, never from an argument
fx whoami
fx profiles
fx logout            # local only: the token keeps working until it expires or is revoked (revoke it in the Developer app)
```

- **Reading:** `fx runs list|show <id>`, `fx work-items list|show <id>|timeline <id>`, `fx discussions list|show <id>|comments <id>`, `fx repos list|show <id>`, `fx webhooks list|show <id>|deliveries <id>`, `fx usage`, `fx budgets`. Lists show one page (`--limit n` sets its size); `--all` follows every page. With `--json`, a single page is the API's body unchanged, and `--all` is one merged page. Runs are shown with their work item's title, read with one extra request (`runs list`: one page of work items; `runs show`: the one work item).
- **Not available to a token:** `webhooks add|test|edit|delete|rotate-secret`, `sites`, `runs retry`, `work-items approve|close|reopen|respec`, `budgets set` and `tokens` exit 6 without sending anything, and print where in the workspace to do it.
- **CI:** set `FX_TOKEN` and `FX_BASE_URL` (`FX_PROFILE` picks a profile). Without `FX_BASE_URL`, the origin comes from `config.json`, and only if its directory is private (0700, yours). Nothing is written to disk. On Windows `FX_TOKEN` is the only way in.
- **Where things live:** `${XDG_CONFIG_HOME:-$HOME/.config}/fulcrumaxe/` holds `credentials.json` (mode 0600, directory 0700) and `config.json` (profile names and origins, no secret). Uninstalling the package leaves this directory; run `fx logout --all` first to remove the saved tokens.
- **A token is tied to the origin it was saved for.** It is sent nowhere else, and redirects are never followed.
- `--json` writes one `{"v":1,"data":...}` (or `{"v":1,"error":...}`) envelope to stdout. `--debug` writes method, path, status and timing to stderr, with the token redacted.
- `fx --help` lists the exit codes.
- This is not the runner: `fx-runner` holds a runner credential, this CLI holds a user token, and their logins are separate.
