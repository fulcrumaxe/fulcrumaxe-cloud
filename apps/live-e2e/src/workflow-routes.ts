/**
 * The Workflow SDK routes (P9), listed from `apps/web`'s BUILT output and never typed by hand.
 *
 * `withWorkflow` generates route handlers at build time under `/.well-known/workflow/`, so the source tree does
 * not name them. After `next build`, `.next/server/app-paths-manifest.json` maps every app route to its file;
 * the keys under that prefix that end in `/route` are the workflow endpoints. A dynamic segment (`[token]`) is
 * replaced by a fixed placeholder so the path can be requested.
 *
 * `live-e2e workflow-routes --build-dir apps/web/.next --out packs/platform/workflow-routes.json` writes the
 * list; with `--check` it fails when the file on disk is not what the build says. Every listed route must be
 * declared as a refusal probe in the `platform` pack (test/workflow-routes.test.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const WORKFLOW_PREFIX = "/.well-known/workflow/";
/** What a dynamic segment becomes: a value no real hook token has. */
export const PLACEHOLDER = "fx-probe";
export const MANIFEST_PATH = join("server", "app-paths-manifest.json");

export class WorkflowRoutesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowRoutesError";
  }
}

/** `/.well-known/workflow/v1/webhook/[token]/route` becomes `/.well-known/workflow/v1/webhook/fx-probe`. */
export function routeFromManifestKey(key: string): string | null {
  if (!key.startsWith(WORKFLOW_PREFIX) || !key.endsWith("/route")) return null;
  const path = key.slice(0, -"/route".length);
  return path
    .split("/")
    .map((seg) => (/^\[\[?\.{0,3}[A-Za-z0-9_]+\]?\]$/.test(seg) ? PLACEHOLDER : seg))
    .join("/");
}

/** Sorted, de-duplicated routes from a build directory (the `.next` folder). Throws when it cannot say. */
export function extractWorkflowRoutes(buildDir: string): string[] {
  const file = join(buildDir, MANIFEST_PATH);
  if (!existsSync(file)) throw new WorkflowRoutesError(`no build output: ${file} does not exist (run \`next build\` in apps/web first)`);
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new WorkflowRoutesError(`${file} is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) throw new WorkflowRoutesError(`${file} is not a route map`);
  const routes = new Set<string>();
  for (const key of Object.keys(manifest)) {
    const route = routeFromManifestKey(key);
    if (route !== null) routes.add(route);
  }
  if (routes.size === 0) throw new WorkflowRoutesError(`${file} lists no ${WORKFLOW_PREFIX} route: the build did not run \`withWorkflow\`, so the list would be empty`);
  return [...routes].sort();
}

export interface WorkflowRoutesFile {
  source: string;
  routes: string[];
}

export function renderRoutesFile(routes: string[]): string {
  const body: WorkflowRoutesFile = { source: "apps/web/.next/server/app-paths-manifest.json", routes };
  return `${JSON.stringify(body, null, 2)}\n`;
}
