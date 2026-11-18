# @fx/hetzner

A typed, strict client for the Hetzner Cloud API, and a small provider-neutral seam on top of it. The client covers locations, server types, pricing, servers, firewalls, SSH keys and actions. It is a library. The one thing outside the package that uses it is the token probe described below.

Sources:
- `packages/hetzner/package.json`
- `packages/hetzner/src/index.ts`
- `packages/hetzner/src/client.ts`
- `packages/hetzner/src/parse.ts`
- `packages/hetzner/src/provider.ts`
- `packages/hetzner/src/probe.ts`
- `packages/hetzner/vitest.config.ts`
- `packages/hetzner/test/`
- `packages/hetzner/test/helpers/strictHetzner.ts`
- `packages/hetzner/test/helpers/createFlow.ts`
- `packages/net-guard/src/`

## What it is for

`packages/hetzner/package.json` describes it as a client with real TLS, bounded timeouts and retries, rate-limit headers honoured, an idempotent server create, and a token that never reaches an error or a log. Its scope, per the header comment in `packages/hetzner/src/client.ts`, is standard-tier Cloud servers: no dedicated servers and no Robot API.

The package is private (`"private": true`, `"license": "UNLICENSED"` in `packages/hetzner/package.json`) and is built in two merged steps: the client core and servers (#1030), then firewalls, SSH keys and power controls (#1031).

## What depends on it

Only `packages/api/package.json` lists `@fx/hetzner`, and the one import is `createHetznerCredentialProbe` in `packages/api/src/routes/machine-credential.ts` (#1057). No app and no server-creating code calls the client or the provider seam yet. Its only workspace dependency is `@fx/net-guard` (`packages/hetzner/package.json`), whose `resolveChecked` and `isBlockedAddress` the client uses to resolve `api.hetzner.cloud` and refuse a blocked address (`packages/hetzner/src/client.ts`). Treat the client and the provider seam below as unwired.

## The client

`packages/hetzner/package.json` exports only `src/index.ts`. `createHetznerClient(options)` from `packages/hetzner/src/client.ts` returns a frozen object. Its `toString` returns `[HetznerClient]` and its `toJSON` returns `{}`, so the token is not exposed by logging or serialising the client.

- **Construction.** `token` is required and must be 8 to 512 printable ASCII characters, else `unauthorized`. Options are `version` (sent as `User-Agent: fulcrumaxe-cloud/<version>`), `timeoutMs` (per attempt, default 15 s), `maxRetries` (default 2) and `maxWaitMs` (the longest rate-limit sleep, default 15 s). `sleep` and `now` can be replaced for tests.
- **Reads.** `verifyToken`, `listLocations`, `listServerTypes`, `getPricing`, `listServers`, `getServer`, `listFirewalls`, `getFirewall`, `listSshKeys`, `getAction` and `getActions`. Lists page at 50 per page and read at most 20 pages; a list longer than that, or a page number that does not advance, is `unavailable`.
- **Servers.** `createServer`, `deleteServer`, `renameServer` and `waitForServer(id, "running" | "deleted", { timeoutMs, intervalMs })`. `checkPlacement(serverType, location)` reads the live lists and refuses an unknown type, an unknown location, or a type not offered there, before anything is created.
- **Power controls.** `rebootServer`, `powerOnServer` and `powerOffServer`. Each returns the `Action` Hetzner reports.
- **Firewalls.** `createFirewall`, `deleteFirewall`, plus the two reads above. A rule takes `direction`, `protocol` (`tcp`, `udp`, `icmp`, `esp` or `gre`), an optional `port`, `sourceIps` or `destinationIps`, and a `description` (`FirewallRuleInput`).
- **SSH keys.** `listSshKeys` (filterable by label selector, name or fingerprint), `createSshKey` and `deleteSshKey`.
- **Deletes are idempotent.** `deleteServer` answers `null` for a server that is already gone, and `deleteFirewall` and `deleteSshKey` answer `false`, rather than throwing `not_found`.
- **Idempotent create.** `createServer` needs an `idempotencyKey` of 1 to 63 letters, digits, dashes, dots or underscores. The key is stored in the server's `fx-create-key` label (`CREATE_KEY_LABEL`). A repeat, or a retry after a lost answer, looks the server up by that label first and returns it with `reused: true`. The client adopts a server only when its name, type, location and every requested label match; a different or a second match is refused as `uniqueness_error` with reason `create_key_mismatch` or `create_key_ambiguous`. `userData` over 32 KiB is refused locally. If the POST fails ambiguously, the same lookup runs before any resend, so a lost answer does not make a second server.
- **Retries.** A read or delete is repeated after a 5xx or a dropped connection, up to `maxRetries`. At the request layer a write is not repeated after an ambiguous failure; only a 429 is repeated, because a refused request did nothing. `createServer` is the one exception: after an ambiguous failure it looks the server up by its create key, and only when none is found does it send the POST again, up to `maxRetries` times. The client tracks `RateLimit-*` response headers and sleeps for the refill when the wait is within `maxWaitMs`, else it throws `rate_limit_exceeded` with a `retryAfter`.
- **Strict reads.** `packages/hetzner/src/parse.ts` reads only the fields the cloud uses and refuses a missing or wrongly typed one as `unavailable`. A create response's `root_password` is never read.
- **Token handling.** Every error message is scrubbed of the token and of `Bearer ...` text, and the client logs nothing. The client also pins the connection to the address it resolved and refuses a blocked one.

Everything above is exported from `packages/hetzner/src/index.ts`, along with the types `HetznerClient`, `HetznerOptions`, `CreateServerInput`, `FirewallRuleInput`, `Action`, `Firewall`, `FirewallRule`, `Location`, `Price`, `Pricing`, `Server`, `ServerStatus`, `ServerType` and `SshKey`.

## The token probe

`createHetznerCredentialProbe(options)` (`packages/hetzner/src/probe.ts`) asks Hetzner what a token can do before the cloud stores it. `check(token)` makes a read (`GET /servers`), then a write: it creates a throwaway SSH key named `fx-probe-<uuid>` and labelled `fx-probe=1`, from a fresh ed25519 key whose private half is never kept, and deletes it again (one retry). It then lists the project's servers and counts those without the `fx-managed=1` label (`MANAGED_LABEL`), which every server the cloud creates will carry. The answer is a closed verdict: `ok` with `unlabelledServers`, `invalid` (Hetzner refused the token), `read_only` (the write was refused) or `unreachable` (anything else). A key that was made but could not be deleted is `unreachable`, because a delete is a write too; the inert key stays in the person's project under its label for a later sweep, and each retry makes its own. The token stays in the client's closure and no result carries it. Tests: `packages/hetzner/test/probe.test.ts`.

## Errors

`HetznerError` (`packages/hetzner/src/client.ts`) carries a closed `code`: `unauthorized`, `forbidden`, `resource_limit_exceeded`, `resource_unavailable`, `placement_error`, `rate_limit_exceeded`, `uniqueness_error`, `invalid_input`, `server_error`, `unavailable` or `not_found`. Any other code Hetzner sends, and every network, TLS, timeout or shape failure, becomes `unavailable`. `extra` holds the HTTP `status`, Hetzner's own `hetznerCode`, `retryAfter`, a `reason`, and `ambiguous`, which is true when the request may or may not have taken effect.

### The provider seam

`packages/hetzner/src/provider.ts` defines `MachineProvider`, an interface whose types carry no Hetzner field names, so another provider could sit behind it. It has `quote`, `create`, `get`, `delete`, `listByLabel`, `createFirewall`, `listFirewalls` and `deleteFirewall`. Ids are opaque strings; the Hetzner implementation turns them into numbers and refuses one that is not a positive integer. `create` returns `{ machine, reused, settled }`, where `settled` is false while the create action is still running. Hetzner Cloud is the only implementation, built by `createHetznerProvider(client)`.

Every provider method throws `MachineProviderError`, never `HetznerError`. Callers switch on its `code`, one of `unavailable`, `not_found`, `conflict`, `rate_limited`, `invalid_input`, `unauthorized`, `in_use` or `mismatch`. The provider's own code goes in `extra.providerCode`, and `extra` also carries `status`, `retryAfter` and `ambiguous` when they apply. `toMachineProviderError` does the mapping:

| Hetzner side | Neutral code |
|---|---|
| `unauthorized`, `forbidden` | `unauthorized` |
| `resource_limit_exceeded`, `resource_unavailable`, `placement_error`, `server_error`, `unavailable` | `unavailable` |
| `rate_limit_exceeded` | `rate_limited` |
| `uniqueness_error` | `conflict` |
| `invalid_input` | `invalid_input` |
| `not_found` | `not_found` |
| reason `create_key_mismatch` or `create_key_ambiguous` | `mismatch` |
| Hetzner code `resource_in_use` (a firewall still applied) | `in_use` |

An error that is not a `HetznerError` passes through unchanged.

## Tests and the strict fake

Run the package tests from the repo root:

```bash
pnpm --filter @fx/hetzner test
pnpm --filter @fx/hetzner typecheck
```

`packages/hetzner/vitest.config.ts` runs `test/**/*.test.ts` with `packages/test-guard/src/setup.ts`. There is no Postgres and no network: every test talks to `startStrictHetzner` in `packages/hetzner/test/helpers/strictHetzner.ts`, a local fake of the Hetzner API served over real TLS. The certificate names `api.hetzner.cloud` and is passed to the client as its `ca`, through the `testTarget` option. The client refuses `testTarget` unless `NODE_ENV` is exactly `test`.

The fake refuses what the real API refuses: the `/v1` prefix, a bearer token it knows, JSON bodies on writes, the `{error:{code,message,details}}` shape, paging limits, rate-limit headers with a gradual refill and a 429 at zero, label patterns, a taken server name or SSH-key fingerprint (409 `uniqueness_error`), the account server limit, a type not offered in a location, and `user_data` over 32 KiB. Failures can be injected through `world.failNext`. Its header comment states what it does not model: boot timing, real prices and the type catalogue, per-endpoint rate limits, image and network validation, firewall application and the exact wording of messages. It is also marked unrecorded: written from Hetzner's published reference, not captured from the live API. The one test that would compare parsed fields to a recorded response is an empty, skipped placeholder in `packages/hetzner/test/client.test.ts`.

`packages/hetzner/test/helpers/createFlow.ts` is the flow a caller builds on the seam alone (quote, firewall, machine). `packages/hetzner/test/provider.test.ts` and `packages/hetzner/test/hetznerProvider.test.ts` run it against the interface and against the Hetzner implementation.
