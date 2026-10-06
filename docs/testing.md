# Testing

Sources:
- `packages/github/test/helpers/`
- `packages/db/test/helpers/`
- `packages/webhooks/test/helpers/selfSignedCert.ts`
- `apps/workspace/e2e/fake-github-authorize.mjs`

## Fakes must be as strict as the real service

A fake that accepts more than the real service accepts hides bugs until the first live run. Three
of them got through that way: GitHub refuses a request with no `User-Agent` (a raw `https.request`
sends none), Node 20 and later call a custom `lookup` with `{ all: true }` on the normal connect
path, and Neon ends the client's TLS at its proxy so the backend never sees it. Each fake of an
outside service has to enforce what the real one enforces that our code touches, and a network call
is tested through Node's real connection path, not through a hand-called stub. When a behaviour
cannot be faked faithfully, say so in the pull request.

### GitHub REST (`packages/github/test/helpers/strictGithub.ts`)

Two ways in, one rule set (`checkGithubRequest`):

- `strictGithubFetch(innerFake)` wraps an in-process `fetch` fake. Use it for every code path that
  takes a `fetchImpl`. It adds the `user-agent: node` and `accept: */*` that real `fetch` sends, so
  it does not reject a call real `fetch` would make. Pass `explicitUserAgent: true` for a caller that
  sets its own User-Agent on purpose.
- `startStrictGithubServer(route)` (`localTlsServer.ts`) is a real HTTPS server applying the same
  rules to the raw request. Nothing is added for the client, so a missing User-Agent really is
  missing. Use it for anything built on `https.request`, such as the pinned transport.

Enforced:

| Behaviour | Real GitHub | The fake |
| --- | --- | --- |
| No `User-Agent` | 403, plain-text body "Request forbidden by administrative rules ..." | the same |
| `Accept` that cannot be JSON | 415, JSON error | the same |
| Unpublished `X-GitHub-Api-Version` | 400, JSON error | the same |
| `Authorization` other than `Bearer <t>` / `token <t>` | 401 "Bad credentials" | the same |
| `/app/...` without a valid App JWT (RS256, issuer, expiry in the future and within ten minutes) | 401 | the same |
| `/installation/...` and `/user...` without credentials | 401 "Requires authentication" | the same |
| A request body that is not JSON, or has no JSON content type | 400 "Problems parsing JSON" | the same |
| Error bodies | JSON with `message`, `documentation_url`, `status` | built by `ghError` |
| Listings (`/installation/repositories`, `/user/installations`) | `total_count`, 100 per page at most, `Link: rel="next"` | `pagedListing`; a listing without `total_count` and its array throws |
| Host | `api.github.com` or `github.com` over HTTPS | any other target throws |

Not faked: rate limits and secondary rate limits, abuse detection, the wording of every error, and
the OAuth device and web flows beyond the token exchange. The messages used are the ones the code
under test branches on.

`apps/workspace/e2e/fake-github-authorize.mjs` stands in for the browser-facing authorize page, not
the REST API. It answers 404 without a `client_id`, 422 for a `redirect_uri` that is not an
absolute URL, 400 without the `state` this app requires, and 404 for anything but GET.

### Node's real connection path (`packages/github/test/helpers/localTlsServer.ts`)

`startLocalTlsServer` serves HTTPS on 127.0.0.1 with a throwaway certificate whose names are the
ones the client connects to (`api.github.com`). The certificate goes to the client as its explicit
`ca`. `rejectUnauthorized: false` is not used, so the SNI name, hostname check and chain check all
run. `httpsRoundTrip` makes the request with `autoSelectFamily` left at its default (on) and refuses
to run if the process turned it off. A pinned `lookup` that does not answer `{ all: true }` fails
here with `ERR_INVALID_IP_ADDRESS`; it passed when the test called the lookup by hand.

The gh-proxy tests run the real pinned transport (`createNodeHttpsPinnedRequester({ port, ca })`)
against the strict GitHub server, including the installation-token mint.

### Postgres behind TLS (`packages/db/test/helpers/pgTls.ts`)

- `enableClusterTls(admin)` turns TLS on in the local test cluster with a throwaway certificate.
  Clients pass it as `ssl: { ca }`.
- `startTlsTerminatingProxy(upstreamPort)` is the Neon shape: the client negotiates and verifies
  TLS with the proxy, which forwards plain bytes to the cluster, so `pg_stat_ssl` on the backend
  reports no TLS. Checks of "is this connection TLS" must therefore look at the client socket.

Not faked: Neon's SNI-based endpoint routing, its pooler, and its public certificate chain.

### Rule of thumb

If you add a fake of an outside service, list what the real service refuses, make the fake refuse
the same, and add a test that the stricter fake would have caught the bug a lenient one let through.
