import { sessionLimitFor } from "./ratelimit/session.js";
import { z } from "zod";
import { SESSION_COOKIE_NAME } from "@fx/core/src/auth/session.js";
import type { RouteEntry } from "./registry.js";

/**
 * D#31 API-1 criterion 10: the published `info.description` must contain
 * this exact sentence, PO's pre-token text ("Owner decisions" / C1's
 * cross-referenced product-owner seat): tokens don't exist yet, so the
 * reference says so until API-10 switches it to the "Stable" text.
 */
export const PRE_TOKEN_DESCRIPTION =
  "The fulcrumaxe public API. API tokens aren't available yet. This reference may change until they launch.";

const ERROR_SCHEMA_NAME = "Error";

/** The shared error envelope every 4xx/5xx response references (criterion 1). */
const errorJsonSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message", "request_id"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        request_id: { type: "string" },
      },
    },
    details: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "code"],
        properties: { path: { type: "string" }, code: { type: "string" } },
      },
    },
  },
};

/** Status codes attached to every operation. A route that needs more (e.g. a 409 DenyReason) can be extended per-operation later; this is the floor every `/api/v1` route shares. */
const COMMON_ERROR_STATUSES = ["401", "403", "404", "422", "500"] as const;

/**
 * Fix round item 3 (code review of this PR): every operation's
 * `security` array names `session` and/or `token`, but nothing defined
 * `components.securitySchemes` for either -- a dangling OpenAPI 3.1
 * reference. "The v1 contract" > Principals and the security seat's
 * token model give the shape each one is: `session` is the
 * `__Host-fx_session` cookie (an `apiKey` scheme, `in: cookie`); `token`
 * is a `Bearer <fxat_...>` credential (an `http` scheme with
 * `scheme: bearer`).
 */
const SECURITY_SCHEMES = {
  session: {
    type: "apiKey",
    in: "cookie",
    name: SESSION_COOKIE_NAME,
    description: "Browser session cookie. Sent automatically by the dashboard; not usable outside a browser.",
  },
  token: {
    type: "http",
    scheme: "bearer",
    description: "An API token minted with `POST /api/v1/tokens`, sent as `Authorization: Bearer fxat_...`.",
  },
} as const;

const SESSION_429_TEXT =
  "Error `rate_limited`: this account or user made too many calls to this operation in a short time. Carries an integer `Retry-After` in seconds; nothing was done.";

function errorResponse(): { description: string; content: Record<string, { schema: { $ref: string } }> } {
  return {
    description: "Error",
    content: { "application/json": { schema: { $ref: `#/components/schemas/${ERROR_SCHEMA_NAME}` } } },
  };
}

interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string; description: string };
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
}

/**
 * Pure function: `RouteEntry[]` -> the OpenAPI 3.1 document. Every
 * operation gets an `operationId` (criterion 1), a `security` entry
 * derived from `principals`, and the shared `Error` schema on every
 * 4xx/5xx response. Schemas convert through zod v4's own
 * `z.toJSONSchema` targeting `draft-2020-12` -- OpenAPI 3.1 adopted JSON
 * Schema 2020-12 directly, so no `openapi-3.0`-style translation layer
 * is needed.
 */
export function buildOpenApiDocument(routes: readonly RouteEntry[]): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    const pathItem = (paths[route.path] ??= {});
    const parameters: unknown[] = [];

    if (route.paramsSchema) {
      const shape = z.toJSONSchema(route.paramsSchema, { target: "draft-2020-12" }) as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      for (const [name, schema] of Object.entries(shape.properties ?? {})) {
        parameters.push({ name, in: "path", required: true, schema });
      }
    }
    if (route.querySchema) {
      const shape = z.toJSONSchema(route.querySchema, { target: "draft-2020-12" }) as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      const required = new Set(shape.required ?? []);
      for (const [name, schema] of Object.entries(shape.properties ?? {})) {
        parameters.push({ name, in: "query", required: required.has(name), schema });
      }
    }

    const responses: Record<string, unknown> = {
      [String(route.successStatus ?? 200)]: {
        description: route.summary ?? route.operationId,
        content: {
          "application/json": {
            schema: z.toJSONSchema(route.responseSchema, { target: "draft-2020-12" }),
          },
        },
      },
    };
    if (route.rawResponse) {
      // D#45 S8: a text body (NDJSON), not a JSON document.
      responses[String(route.successStatus ?? 200)] = {
        description: route.summary ?? route.operationId,
        headers: Object.fromEntries(
          Object.entries(route.rawResponse.headers).map(([name, description]) => [name, { description, schema: { type: "string" } }]),
        ),
        content: { [route.rawResponse.contentType]: { schema: { type: "string", description: route.rawResponse.description } } },
      };
    }
    for (const status of COMMON_ERROR_STATUSES) {
      responses[status] = errorResponse();
    }
    for (const [status, description] of Object.entries(route.extraResponses ?? {})) {
      responses[status] = {
        ...errorResponse(),
        description,
        ...(status === "429" ? { headers: { "Retry-After": { description: "Seconds to wait before trying again.", schema: { type: "integer", minimum: 1 } } } } : {}),
      };
    }
    if (route.stream) {
      const ok = responses[String(route.successStatus ?? 200)] as { content: Record<string, unknown> };
      ok.content["text/event-stream"] = {
        schema: { type: "string", description: route.stream.description },
      };
      responses["403"] = {
        ...errorResponse(),
        description: "Error. In stream mode, `cross_site_refused` (a cookie-authenticated open sent from another site), in addition to `session_required`, `insufficient_scope` and `insufficient_role`. Refused before any stream byte is sent.",
      };
      responses["422"] = {
        ...errorResponse(),
        description: "Error. In stream mode, and in JSON mode with a cursor, `invalid_cursor`: a `Last-Event-ID` / `?cursor=` that is malformed, forged, or belongs to another account. Refused before any stream byte is sent.",
      };
    }
    // D#31 API-3d (C13c criterion 8): every token-accepting operation
    // documents 429 -- the token and tenant per-minute caps apply to any
    // route a token principal can reach, not only the ones with a
    // per-route override.
    if ((route.principals ?? ["session"]).includes("token")) {
      responses["429"] = errorResponse();
    }
    // Session callers have caps too (rate_limited with Retry-After): every session write, and any session read
    // that declares its own `sessionLimit`. The route's own 429 text, when it wrote one, is kept.
    const sessionCapped = (route.principals ?? ["session"]).includes("session") && sessionLimitFor(route) !== undefined;
    if (sessionCapped || (route.principals ?? ["session"]).includes("token")) {
      const own = route.extraResponses?.["429"];
      responses["429"] = {
        ...errorResponse(),
        description: own ?? (sessionCapped ? SESSION_429_TEXT : "Error `rate_limited`. Carries an integer `Retry-After` in seconds."),
        headers: { "Retry-After": { description: "Seconds to wait before trying again.", schema: { type: "integer", minimum: 1 } } },
      };
    }
    if (route.stream) {
      responses["429"] = {
        description:
          "Error `stream_limit` (too many open streams for this user, account or plan; sent as JSON before any stream byte, with no `retry:` field), or `rate_limited` for a token. Carries an integer `Retry-After` in seconds.",
        headers: {
          "Retry-After": { description: "Seconds to wait before opening another stream.", schema: { type: "integer", minimum: 1 } },
        },
        content: { "application/json": { schema: { $ref: `#/components/schemas/${ERROR_SCHEMA_NAME}` } } },
      };
    }

    pathItem[route.method.toLowerCase()] = {
      operationId: route.operationId,
      summary: route.summary,
      ...(route.description ? { description: route.description } : {}),
      // The token entry names the scope a token must hold (OpenAPI 3.1 allows role names for non-OAuth schemes); a self-only route needs none.
      security: (route.principals ?? ["session"]).map((kind) => ({
        [kind]: kind === "token" && route.scope && !route.tokenSelfOnly ? [route.scope] : [],
      })),
      ...(route.tokenSelfOnly ? { "x-fx-token-self-only": true } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(route.bodySchema
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: z.toJSONSchema(route.bodySchema, { target: "draft-2020-12" }),
                },
              },
            },
          }
        : {}),
      responses,
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "fulcrumaxe public API",
      version: "1.0.0",
      description: PRE_TOKEN_DESCRIPTION,
    },
    paths,
    components: {
      schemas: { [ERROR_SCHEMA_NAME]: errorJsonSchema },
      securitySchemes: SECURITY_SCHEMES,
    },
  };
}

/**
 * The ONE serialization used both by `scripts/gen-openapi.ts` (writes the
 * committed file) and `test/openapi-drift.test.ts` (recomputes it in
 * memory) -- criterion 1's "byte for byte" only holds if both go through
 * this, never a bare `JSON.stringify` at either call site.
 */
export function serializeOpenApiDocument(doc: OpenApiDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
