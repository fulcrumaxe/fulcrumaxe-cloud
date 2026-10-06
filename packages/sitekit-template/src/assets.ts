import path from "node:path";
import fs from "node:fs";
import { isAssetPath } from "@fx/sitekit-claims";

/**
 * Resolves a `backgroundImage` (K01's `AssetPath`) against a fixed,
 * sandboxed asset directory (D#2606 K03 constraint): never a plain
 * `path.join(assetRoot, callerValue)` with no follow-up check.
 *
 * K01's AssetPath shape already can't *spell* a traversal — its slug
 * alphabet has no dot in it at all, so `..` cannot appear in a segment, and
 * the schema is re-validated at parse time. This function does not rely on
 * that alone, for two reasons: (1) it is the defensive boundary for any
 * caller that constructed a SiteContent without going through
 * `SiteContent.parse()`, mirroring why K01's own `gateSite` re-validates
 * everything gateSite can already see; (2) a syntactically valid path can
 * still name a file that was never registered as one of this site's
 * assets. So every resolution re-checks the shape, re-resolves the real
 * path, and confirms containment before ever touching the filesystem for a
 * final answer.
 */
export class AssetResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetResolutionError";
  }
}

export interface ResolvedAsset {
  /** Root-relative URL this asset is served at — identical to the
   * validated AssetPath, since the sandboxed asset tree and the rendered
   * site's own tree share the same relative layout. */
  url: string;
  /** Absolute path to the real file, guaranteed to be inside assetRoot. */
  absPath: string;
}

export function resolveAssetPath(assetRoot: string, assetPath: string): ResolvedAsset {
  if (!isAssetPath(assetPath)) {
    throw new AssetResolutionError(`not a valid asset path: ${assetPath}`);
  }

  const resolvedRoot = path.resolve(assetRoot);
  // assetPath is root-relative ("/images/foo.png"); "." + assetPath makes it
  // a same-directory-relative path so `path.resolve` joins it under
  // resolvedRoot rather than treating it as absolute from "/".
  const candidate = path.resolve(resolvedRoot, "." + assetPath);
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;

  if (candidate !== resolvedRoot && !candidate.startsWith(rootWithSep)) {
    // Defense in depth (see docstring): unreachable through a schema-valid
    // AssetPath today, but this function must not trust that forever.
    throw new AssetResolutionError(`asset path escapes the sandboxed asset directory: ${assetPath}`);
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(candidate);
  } catch {
    throw new AssetResolutionError(`asset not found in the sandboxed asset directory: ${assetPath}`);
  }
  if (!stat.isFile()) {
    throw new AssetResolutionError(`asset path does not resolve to a file: ${assetPath}`);
  }

  return { url: assetPath, absPath: candidate };
}

/** Threaded through rendering: the sandboxed root every AssetPath resolves
 * against, plus every asset actually referenced (url -> real file), so the
 * write step can copy exactly what was used and nothing else. */
export interface RenderEnv {
  assetRoot: string;
  /** Mutated by renderers as they resolve backgroundImage props. */
  assets: Map<string, string>;
}

export function referenceAsset(env: RenderEnv, assetPath: string): string {
  const resolved = resolveAssetPath(env.assetRoot, assetPath);
  env.assets.set(resolved.url, resolved.absPath);
  return resolved.url;
}
