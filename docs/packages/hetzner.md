# @fx/hetzner

A typed, strict client for the Hetzner Cloud API, and a small provider-neutral seam on top of it. The client covers locations, server types, pricing, servers, firewalls, SSH keys and actions. It is a library, and it also ships a small in-memory fake of the API that staging serves (see "The staging fake").

Sources:
- `packages/hetzner/package.json`
- `packages/hetzner/src/index.ts`
- `packages/hetzner/src/client.ts`
- `packages/hetzner/src/parse.ts`
- `packages/hetzner/src/provider.ts`
- `packages/hetzner/src/probe.ts`
- `packages/hetzner/src/fake.ts`
- `packages/hetzner/src/fakeGate.ts`
- `packages/api/src/machines/servers.ts`
- `packages/api/src/machines/lifecycle.ts`
- `apps/web/app/api/%5Ffake/hetzner/[...path]/handler.ts`
- `apps/web/app/api/health/handler.ts`
- `packages/hetzner/vitest.config.ts`
- `packages/hetzner/test/`
- `packages/hetzner/test/helpers/strictHetzner.ts`
- `packages/hetzner/test/helpers/createFlow.ts`
- `packages/net-guard/src/`

## What it is for

`packages/hetzner/package.json` describes it as a client with real TLS, bounded timeouts and retries, rate-limit headers honoured, an idempotent server create, and a token that never reaches an error or a log. Its scope, per the header comment in `packages/hetzner/src/client.ts`, is standard-tier Cloud servers: no dedicated servers and no Robot API.

The package is private (`"private": true`, `"license": "UNLICENSED"` in `packages/hetzner/package.json`) and is built in two merged steps: the client core and servers (#1030), then firewalls, SSH keys and power controls (#1031).

## What depends on it

`packages/api/package.json` and `apps/web/package.json` list `@fx/hetzner`. Its callers are:

- `createHetznerCredentialProbe` in `packages/api/src/routes/machine-credential.ts` (#1057), the token probe below.
- The machine server code in `packages/api/src/machines/servers.ts` (quote and create, #1177) and `packages/api/src/machines/lifecycle.ts` (following a server after it is made, delete, and the sweep for leftovers, #1182). They build a client per call from the person's stored token and use it for the quote, create and delete of a server. When a create was sent, no server id came back and the undo cannot rule a server out, `createServer` answers 503 `server_outcome_unknown` with one fixed text (Hetzner's own code is reported, never sent) and the row ends `failed` with the failure code `cleanup_failed`; a repeat with the same idempotency key against such a row gets the same answer instead of the stored row (`packages/api/src/machines/servers.ts`, #1240).
- The staging fake route and the health check in `apps/web` (below).

Its only workspace dependency is `@fx/net-guard` (`packages/hetzner/package.json`), whose `resolveChecked` and `isBlockedAddress` the client uses to resolve the Hetzner host and refuse a blocked address (`packages/hetzner/src/client.ts`).

## The client

`packages/hetzner/package.json` exports only `src/index.ts`. `createHetznerClient(options)` from `packages/hetzner/src/client.ts` returns a frozen object. Its `toString` returns `[HetznerClient]` and its `toJSON` returns `{}`, so the token is not exposed by logging or serialising the client.

- **Construction.** `token` is required and must be 8 to 512 printable ASCII characters, else `unauthorized`. Options are `version` (sent as `User-Agent: fulcrumaxe-cloud/<version>`), `timeoutMs` (per attempt, default 15 s), `maxRetries` (default 2) and `maxWaitMs` (the longest rate-limit sleep, default 15 s). `sleep` and `now` can be replaced for tests.
- **Reads.** `verifyToken`, `listLocations`, `listServerTypes`, `getPricing`, `listServers`, `getServer`, `listFirewalls`, `getFirewall`, `listSshKeys`, `getAction` and `getActions`. Lists page at 50 per page and read at most 20 pages; a list longer than that, or a page number that does not advance, is `unavailable`.
- **Servers.** `createServer`, `deleteServer`, `renameServer` and `waitForServer(id, "running" | "deleted", { timeoutMs, intervalMs })`. `checkPlacement(serverType, location)` reads the live lists and refuses an unknown type, an unknown location, or a type not offered there, before anything is created.
- **Power controls.** `rebootServer`, `powerOnServer` and `powerOffServer`. Each returns the `Action` Hetzner reports.
- **Firewalls.** `createFirewall`, `deleteFirewall`, plus the two reads above. A rule takes `direction`, `protocol` (`tcp`, `udp`, `icmp`, `esp` or `gre`), an optional `port`, `sourceIps` or `destinationIps`, and a `description` (`FirewallRuleInput`).
- **SSH keys.** `listSshKeys` (filterable by label selector, name or fingerprint), `createSshKey` and `deleteSshKey`.
- **Deletes are idempotent.** `deleteServer` answers `null` for a server that is already gone, and `deleteFirewall` and `deleteSshKey` answer `false`, rather than throwing `not_found`.
- **Idempotent create.** `createServer` needs an `idempotencyKey` of 1 to 63 letters, digits, dashes, dots or underscores. The key is stored in the server's `fx-create-key` label (`CREATE_KEY_LABEL`). A repeat, or a retry after a lost answer, looks the server up by that label first and returns it with `reused: true`. The client adopts a server only when its name, type, location and every requested label match; a different or a second match is refused as `uniqueness_error` with reason `create_key_mismatch` or `create_key_ambiguous`. `userData` over 32 KiB is refused locally. If the POST fails ambiguously, the same lookup runs before any resend, so a lost answer does not make a second server. Once any send of the create has ended ambiguously, every later `HetznerError` in that call (the re-send's refusal, a uniqueness refusal, or a failed look-up, whatever its own code) is rethrown as ambiguous with its code, status, `retryAfter` and remote kept, because the first send may still land (`writeOrFind` in `packages/hetzner/src/client.ts`, #1240).
- **Retries.** A read or delete is repeated after a 5xx or a dropped connection, up to `maxRetries`. At the request layer a write is not repeated after an ambiguous failure; only a 429 is repeated, because a refused request did nothing. `createServer` is the one exception: after an ambiguous failure it looks the server up by its create key, and only when none is found does it send the POST again, up to `maxRetries` times. The client tracks `RateLimit-*` response headers and sleeps for the refill when the wait is within `maxWaitMs`, else it throws `rate_limit_exceeded` with a `retryAfter`.
- **Strict reads.** `packages/hetzner/src/parse.ts` reads only the fields the cloud uses and refuses a missing or wrongly typed one as `unavailable`. A create response's `root_password` is never read.
- **Token handling.** Every error message is scrubbed of the token and of `Bearer ...` text, and the client logs nothing. The client also pins the connection to the address it resolved and refuses a blocked one.

Everything above is exported from `packages/hetzner/src/index.ts`, along with the types `HetznerClient`, `HetznerOptions`, `CreateServerInput`, `FirewallRuleInput`, `Action`, `Firewall`, `FirewallRule`, `Location`, `Price`, `Pricing`, `Server`, `ServerStatus`, `ServerType` and `SshKey`.

## The token probe

`createHetznerCredentialProbe(options)` (`packages/hetzner/src/probe.ts`) asks Hetzner what a token can do before the cloud stores it. `check(token)` makes a read (`GET /servers`), then a write: it creates a throwaway SSH key named `fx-probe-<uuid>` and labelled `fx-probe=1`, from a fresh ed25519 key whose private half is never kept, and deletes it again (one retry). It then lists the project's servers and counts those without the `fx-managed=1` label (`MANAGED_LABEL`), which every server the cloud creates will carry. The answer is a closed verdict: `ok` with `unlabelledServers`, `invalid` (Hetzner refused the token), `read_only` (the write was refused) or `unreachable` (anything else). A key that was made but could not be deleted is `unreachable`, because a delete is a write too; the inert key stays in the person's project under its label for a later sweep, and each retry makes its own. The token stays in the client's closure and no result carries it. Tests: `packages/hetzner/test/probe.test.ts`.

## Errors

`HetznerError` (`packages/hetzner/src/client.ts`) carries a closed `code`: `unauthorized`, `forbidden`, `resource_limit_exceeded`, `resource_unavailable`, `placement_error`, `rate_limit_exceeded`, `uniqueness_error`, `invalid_input`, `server_error`, `unavailable` or `not_found`. Any other code Hetzner sends, and every network, TLS, timeout or shape failure, becomes `unavailable`. `extra` holds the HTTP `status`, Hetzner's own `hetznerCode`, `retryAfter`, a `reason`, and `ambiguous`, which is true when the request may or may not have taken effect.

## The staging fake

`packages/hetzner/src/fake.ts` exports `handleFake`, a pure function over a JSON state (`emptyFakeState`, `FakeState`) that answers the Hetzner paths the client uses: locations, server types, pricing, servers and their power and image actions, firewalls, images and SSH keys (#1196). It is written from Hetzner's published reference and is not recorded from the live API. Its header comment lists what it does not model: actions finish at once, a new server is `initializing` for one poll, an image finishes on its second poll, there is a two-entry catalogue, and there are no rate limits. It keeps at most `FAKE_LIMITS` of each thing (10 servers, 20 of the rest, 50 rules) and answers 403 `resource_limit_exceeded` past that. `fakeAuthOk` accepts any non-empty bearer token except one that looks like a real Hetzner token (64 letters and digits).

`apps/web/app/api/%5Ffake/hetzner/[...path]/handler.ts` serves it at `/api/_fake/hetzner/v1/*`, keeping the state in one row of `fake_provider_state` under a row lock. The folder name is `%5Ffake` because Next treats a folder starting with `_` as private. The handler refuses a body over 64 KiB and answers a plain 404 unless the gate below is open.

The gate is `fakeProviderAllowed` in `packages/hetzner/src/fakeGate.ts`: `FX_MACHINE_PROVIDER_FAKE` must be exactly `1` and `FX_DEPLOY_KIND` exactly `staging`. The client option `fakeBaseUrl` points `createHetznerClient` at such a route; the client refuses it, and the route answers 404, whenever the gate is closed, and the usual DNS, TLS and address checks still apply. `fakeProviderInProduction` names the misconfiguration of the variable being set on a deployment that is not staging, and `apps/web/app/api/health/handler.ts` reports it as `fake_provider_in_production`. The variable is declared in `apps/web/env-manifest.ts`.

### The provider seam

`packages/hetzner/src/provider.ts` defines `MachineProvider`, an interface whose types carry no Hetzner field names, so another provider could sit behind it. It has `quote`, `create`, `get`, `delete`, `listByLabel`, `createFirewall`, `listFirewalls` and `deleteFirewall`. Ids are opaque strings; the Hetzner implementation turns them into numbers and refuses one that is not a positive integer. `create` returns `{ machine, reused, settled }`, where `settled` is false while the create action is still running. Hetzner Cloud is the only implementation, built by `createHetznerProvider(client)`. No code outside the package's tests builds it yet: `packages/api/src/machines/servers.ts` calls the client directly.

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

## What the cloud does with a server after it is made

The package is only the client. The cloud's own use of it is in `packages/api/src/machines/` and is reached through `/api/v1/machine-servers` (create, list, read, delete), `/api/v1/machine-servers/catalog` and `/quote`. A server row (`managed_servers`) moves through `creating`, `booting`, `registering` and then `ready` or `needs_claude_login`, or ends `failed`, `deleting`, `deleted` or `orphaned`.

- **After the create (`lifecycle.ts`).** A queued worker looks at a server that is not final, sleeps between looks and stops at the first final status; nothing polls on a schedule. When the machine's runner has said hello, `ready` means the runner reports a Claude login and `needs_claude_login` means it does not. A server that is not registered after 35 minutes is marked `failed`. Delete refuses while a project is placed on the server, revokes the runner and its provisioning token, deletes the server and then its firewall (a 404 counts as done), and a repeat finishes what the first left.
- **The orphan sweep.** Every 6 hours per credential the cloud lists the servers that carry both of its labels in that account's own Hetzner project. A labelled server with no row becomes an `orphaned` row; a row whose server Hetzner no longer has becomes `deleted`. The sweep deletes nothing.
- **Three actions on one server (`actions.ts`, #1232).** `POST /api/v1/machine-servers/{id}/reboot` sends Hetzner's reboot for a server that is `registering`, `needs_claude_login` or `ready` (else `409 server_not_rebootable`). `POST .../keep` records that the person knows about an orphan and wants it left alone (`kept_at`, `kept_by`, one audit row); it changes nothing at Hetzner and the row stays `orphaned`. `POST .../delete-orphan` deletes an orphan and its labelled firewall. All three are for an owner or admin, and an id that is not a server of the caller's account answers the same 404 as one that does not exist, without calling Hetzner.
- **What it costs (`spend.ts`, #1231, #1262).** `GET /api/v1/billing/machines` answers Budget & billing's Machines section whole, so the page does no arithmetic. For each server it adds `min(billed hours x hourly price, monthly price)` and the same for the IPv4 address, from the prices stamped when the server was made, with the hours rounded up to whole started hours. A server made before the hourly IPv4 price was stamped counts its address at the full monthly price and is marked an estimate; a server with no stamped price is listed without a cost and left out of the totals. Totals are per currency and summed by Postgres on numeric. Claude usage is token counts per machine and project from `machine_usage_daily`, priced with the cloud's own price table as "at API prices" (a tier with no price row keeps its tokens and shows no dollar figure), and each machine says who pays for it: covered by the person's Claude plan, or billed to their API key. Any member reads the totals; the per-server rows are for owners and admins.

## Tests and the strict fake

Run the package tests from the repo root:

```bash
pnpm --filter @fx/hetzner test
pnpm --filter @fx/hetzner typecheck
```

`packages/hetzner/vitest.config.ts` runs `test/**/*.test.ts` with `packages/test-guard/src/setup.ts`. There is no Postgres and no network: every test talks to `startStrictHetzner` in `packages/hetzner/test/helpers/strictHetzner.ts`, a local fake of the Hetzner API served over real TLS. The certificate names `api.hetzner.cloud` and is passed to the client as its `ca`, through the `testTarget` option. The client refuses `testTarget` unless `NODE_ENV` is exactly `test`.

The fake refuses what the real API refuses: the `/v1` prefix, a bearer token it knows, JSON bodies on writes, the `{error:{code,message,details}}` shape, paging limits, rate-limit headers with a gradual refill and a 429 at zero, label patterns, a taken server name or SSH-key fingerprint (409 `uniqueness_error`), the account server limit, a type not offered in a location, and `user_data` over 32 KiB. Failures can be injected through `world.failNext`, optionally only for one path and after a number of passes. `world.deleteSteps` makes a server delete finish only after that many polls of its action, with the firewall still applied until then, and `world.priceMonthlyDelta` moves every monthly price, to test a price that changed between a quote and a create. Its header comment states what it does not model: boot timing, real prices and the type catalogue, per-endpoint rate limits, image and network validation, firewall application and the exact wording of messages. It is also marked unrecorded: written from Hetzner's published reference, not captured from the live API. The one test that would compare parsed fields to a recorded response is an empty, skipped placeholder in `packages/hetzner/test/client.test.ts`.

`packages/hetzner/test/helpers/createFlow.ts` is the flow a caller builds on the seam alone (quote, firewall, machine). `packages/hetzner/test/provider.test.ts` and `packages/hetzner/test/hetznerProvider.test.ts` run it against the interface and against the Hetzner implementation.
