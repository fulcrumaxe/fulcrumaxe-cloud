// D#749 V2c-2b: the Playwright library of the single executable, found ONLY in the sidecar folder laid down next to the binary.
// `require.resolve(name, { paths })` is not a fence: Node still walks the parent folders' node_modules and always adds NODE_PATH and the user's ~/.node_modules, so a copy planted
// there would be loaded into the verify server, which holds the test account's saved session. So the resolved file is checked after the fact: its real path (links resolved) has to lie
// under the real path of <sidecar>/node_modules/<name>, and what is loaded is that checked file, never the bare name. Anything else is "not available".
//
// D#749 V2c-2c: with `options.digest` the folder must also BE the sidecar this binary was built with: a plain tree (no link, no device) whose whole-tree digest (scripts/sidecar.mjs) equals the one
// the build baked into the program. A folder with a file edited, added or removed, or a library swapped for another, is "not available" like an absent one. A digest option that is not 64 hex digits
// (a build that did not bake one in) means nothing is ever available: fail closed. Without the option (running from source) the folder is only fenced, as before.
import { realpathSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { treeSignature, verifySidecar } from "../scripts/sidecar.mjs";

// D#749 V2c-2c (security review): the digest and the check above cover the library's own files, but code the library loads goes through Node's lookup too. playwright-core's bundled `ws` does
// `require("bufferutil")` and `require("utf-8-validate")`, which resolve through parent node_modules folders, NODE_PATH and ~/.node_modules, and a copy planted there RAN during load().
// So (1) a resolve fence is installed before anything is loaded: a resolution requested BY a file inside the sidecar must end inside the sidecar (links resolved) or at a node: built-in, else it
// throws (the optional requires are in try/catch and fall back to plain JavaScript); the fence stays for the life of the process, so a lazy require later is covered too; and (2) ws is told not to
// try those two optional addons at all. A writer of the sidecar folder itself (the same user) is out of scope: that user could just as well replace the binary.
const fenced = new Set();
const inside = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);
function installFence(realSidecar) {
  process.env.WS_NO_BUFFER_UTIL = "1";
  process.env.WS_NO_UTF_8_VALIDATE = "1";
  if (typeof registerHooks !== "function") throw new Error("no_resolve_hooks");
  if (fenced.has(realSidecar)) return;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      let from;
      try {
        from = context.parentURL === undefined || !context.parentURL.startsWith("file:") ? undefined : fileURLToPath(context.parentURL);
      } catch {
        from = undefined;
      }
      if (from === undefined || !inside(realSidecar, from)) return result;
      if (result.url.startsWith("node:")) return result;
      let target;
      try {
        target = result.url.startsWith("file:") ? realpathSync(fileURLToPath(result.url)) : undefined;
      } catch {
        target = undefined;
      }
      if (target === undefined || !inside(realSidecar, target)) throw new Error(`sidecar_fence: a module outside the sidecar folder was refused (${String(specifier).slice(0, 80)})`);
      return result;
    },
  });
  fenced.add(realSidecar);
}

/** The loader for library `name` in `sidecar` (the folder that holds `node_modules`). */
export function sidecarLibrary(sidecar, name = "playwright-core", options = {}) {
  const pinned = Object.hasOwn(options, "digest");
  const digestOk = !pinned || /^[0-9a-f]{64}$/.test(String(options.digest));
  // The folder was fully hashed against the digest when its fingerprint was this one; a probe that finds the same fingerprint does not hash again.
  let verifiedSignature;
  const intact = (full) => {
    if (!pinned) return true;
    if (!digestOk) return false;
    try {
      const signature = treeSignature(sidecar);
      if (!full && signature === verifiedSignature) return true;
      if (!verifySidecar(sidecar, options.digest)) return false;
      verifiedSignature = signature;
      return true;
    } catch {
      return false;
    }
  };
  const resolved = (full) => {
    if (!intact(full)) return undefined;
    try {
      installFence(realpathSync(sidecar));
      const require = createRequire(path.join(sidecar, "load.cjs"));
      const found = realpathSync(require.resolve(name, { paths: [sidecar] }));
      const home = path.join(realpathSync(path.join(sidecar, "node_modules")), name);
      return found.startsWith(`${home}${path.sep}`) ? { require, found } : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    available: () => resolved(false) !== undefined,
    load: async () => {
      const there = resolved(true);
      if (there === undefined) throw new Error("playwright_missing");
      return there.require(there.found);
    },
  };
}
