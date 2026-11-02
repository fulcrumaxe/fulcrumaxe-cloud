import { ForbiddenError } from "@fx/core/src/tenancy/errors.js";
import { InsufficientScopeError, SessionRequiredError } from "./errors.js";
import type { Principal } from "./principal.js";
import { effectivePrincipals, ROLE_RANK, type RouteEntry } from "./registry.js";

/**
 * The one route-auth policy every transport applies after it has a principal: principal kind, token scope, token class (an assistant
 * delegation token only where the route lists it), then role. The JSON dispatcher (handler.ts) and the stream open (sse/stream.ts)
 * both call this, so a new transport cannot decide it differently. access.test.ts pins both call sites.
 */
export function assertRouteAccess(
  principal: Principal,
  access: Pick<RouteEntry, "principals" | "scope" | "tokenSelfOnly" | "tokens" | "minRole">,
): void {
  if (!effectivePrincipals(access).includes(principal.kind)) throw new SessionRequiredError();
  if (principal.kind === "token") {
    // tokenSelfOnly admits any token past this check; the route's own handler enforces the self-only id rule.
    if (!access.tokenSelfOnly && (!access.scope || !principal.scopes.includes(access.scope))) throw new InsufficientScopeError();
    if (!(access.tokens ?? ["api"]).includes(principal.delegation ? "delegation" : "api")) {
      throw principal.delegation ? new InsufficientScopeError() : new SessionRequiredError();
    }
  }
  if (ROLE_RANK[principal.role] < ROLE_RANK[access.minRole]) {
    throw new ForbiddenError(`requires role >= ${access.minRole}, got ${principal.role}`);
  }
}
