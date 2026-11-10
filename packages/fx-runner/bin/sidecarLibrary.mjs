// D#749 V2c-2b: the Playwright library of the single executable, found ONLY in the sidecar folder laid down next to the binary.
// `require.resolve(name, { paths })` is not a fence: Node still walks the parent folders' node_modules and always adds NODE_PATH and the user's ~/.node_modules, so a copy planted
// there would be loaded into the verify server, which holds the test account's saved session. So the resolved file is checked after the fact: its real path (links resolved) has to lie
// under the real path of <sidecar>/node_modules/<name>, and what is loaded is that checked file, never the bare name. Anything else is "not available".
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** The loader for library `name` in `sidecar` (the folder that holds `node_modules`). */
export function sidecarLibrary(sidecar, name = "playwright-core") {
  const resolved = () => {
    try {
      const require = createRequire(path.join(sidecar, "load.cjs"));
      const found = realpathSync(require.resolve(name, { paths: [sidecar] }));
      const home = path.join(realpathSync(path.join(sidecar, "node_modules")), name);
      return found.startsWith(`${home}${path.sep}`) ? { require, found } : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    available: () => resolved() !== undefined,
    load: async () => {
      const there = resolved();
      if (there === undefined) throw new Error("playwright_missing");
      return there.require(there.found);
    },
  };
}
