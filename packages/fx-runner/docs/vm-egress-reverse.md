# MicroVM egress: the reverse endpoint

A microVM has no network card and trusts no extra CA. Two host-side listeners serve it, both on the VM's own vsock directory, so a request is
attributed to a sandbox by the socket it arrived on and never by anything the guest sends:

| Port | Socket | Serves |
|------|--------|--------|
| 5253 | `v.sock_5253` | `CONNECT host:443` tunnels to hosts the policy allows with no rules (package registry). |
| 5254 | `v.sock_5254` | Plain HTTP, for hosts whose policy rule rewrites the request (a `forwardURL` or a header `transform`), and for a host the policy lists with no rules, which it serves as itself. |

A rewritten host cannot be tunnelled, because the rewrite and the credential live inside the TLS session. The tunnel refuses it
(`interception_required`, with an `x-egress-hint` header naming port 5254). The reverse endpoint terminates nothing: it takes the guest's plain
HTTP request, makes its own upstream TLS request with full certificate verification, applies the policy's header transform (or sends to the
validated `forwardURL` with the guest's path appended and `x-forwarded-host` set to the policy host), adds any host-side credentials from the
runner's `inject` option, and streams the answer back. The guest never holds a credential, and a credential-shaped header it sends (authorization,
cookie, anything with token, key, secret or signature in its name, `x-forwarded-*`, `vercel-*`) is dropped.

## How the guest points at it

The guest image runs two relays (`infra/microvm-image/guest/relay.py`, started by the guest's `init`, each started again if it ends): `127.0.0.1:5253` copies
bytes to vsock port 5253 of the host (CID 2), and `127.0.0.1:80` to vsock port 5254. They accept only those two pairs, listen on the loopback only and
decide nothing. The guest's hosts file maps `api.anthropic.com` and `github.com` (the runner's `REVERSE_HOSTS`) to `127.0.0.1`, and each tool is told
to use plain HTTP for that host:

- Model API: `ANTHROPIC_BASE_URL=http://api.anthropic.com` (the gateway host the same way). The request's Host header names the policy host, which is
  what the endpoint routes on. The key header is added on the host; the tool's own placeholder key is dropped.
- Git: `git config --global url."http://github.com/".insteadOf "https://github.com/"`. Other forwarded hosts are set the same way, each tool by
  its own base-URL setting.
- Package registry: nothing. `registry.npmjs.org` is a direct host and goes through the CONNECT tunnel on 5253.

A job's own policy is a plain list of hosts (`{ allow: ["api.anthropic.com"] }`), so a host listed with no rules is served here as itself: the same host
the tunnel would open, with the same address checks, nothing added to the request and the guest's credential-shaped headers still dropped. Only an exact
name in the policy counts. A host whose rules this endpoint cannot apply stays refused (`unsupported_rules`), and one that is not listed is `not_allowed`.
The runner's own `inject` hook, when it is given one, still adds its headers last.

## What it refuses (a fixed answer, never an address)

Method other than GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS; CONNECT and upgrades; conflicting or repeated length or transfer-encoding headers;
a missing, repeated or non-DNS Host, or one with a port other than 80; an absolute-form URL that is not `http://` plus the same host; a host with no
route in this sandbox's policy (including a host whose rules carry `match`, `response`, several rules, or a header that is not plain printable
ASCII); a path that decodes to `.`, `..`, a backslash or a control byte; a name that resolves to a blocked, mapped, or this host's own address.

Limits (defaults): request body 32 MiB, response 512 MiB, 120 s to response headers, 120 s idle between chunks (so server-sent events with
keep-alive pings run), 30 min total.
