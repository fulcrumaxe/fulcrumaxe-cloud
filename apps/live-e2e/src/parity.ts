/**
 * Device parity: the live projects must be the workspace projects. Pure comparison, used by
 * `test/devices-parity.test.ts`; it returns a list of differences, empty when the two agree.
 */
import { isDeepStrictEqual } from "node:util";

export interface ProjectLike {
  name?: string | undefined;
  use?: unknown;
}

export function diffProjects(live: readonly ProjectLike[], workspace: readonly ProjectLike[]): string[] {
  const out: string[] = [];
  const names = (ps: readonly ProjectLike[]) => ps.map((p) => p.name ?? "");
  if (!isDeepStrictEqual(names(live), names(workspace))) {
    out.push(`project names differ: live [${names(live).join(", ")}] vs workspace [${names(workspace).join(", ")}]`);
  }
  for (const w of workspace) {
    const l = live.find((p) => p.name === w.name);
    if (l !== undefined && !isDeepStrictEqual(l.use, w.use)) out.push(`project "${w.name ?? ""}": "use" differs`);
  }
  return out;
}

/** The pinned `@playwright/test` of a package.json, or undefined. */
export function playwrightPin(pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }): string | undefined {
  return pkg.devDependencies?.["@playwright/test"] ?? pkg.dependencies?.["@playwright/test"];
}
