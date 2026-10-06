// The same route apps/web serves, so the audited handler is the one that runs.
// `runtime` and `dynamic` must be literal in the route file itself.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export { GET, HEAD, POST, PUT, PATCH, DELETE } from "../../../../../web/app/api/gh-proxy/[...path]/route";
