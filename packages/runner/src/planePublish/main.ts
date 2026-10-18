import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { runPlanePublish } from "./hook.js";
import { MAX_INPUT_BYTES, PLANE_PUBLISH_INPUT_PATH, parsePlanePublishInput, phaseLine } from "./protocol.js";

/**
 * D#598 P1f-5a: the entry that is built to `fx-plane-publish.mjs` (see `hook.ts`). It reads the worker's one input file without following a
 * link, runs the hook against GitHub's two hosts (which the sandbox forwards to the proxy), and prints the phase lines. A bad input is a closed
 * `refused`; anything unexpected is a non-zero exit with no terminal line, which the worker treats as a crash.
 */
function readInput(): string | undefined {
  try {
    const dir = lstatSync(path.dirname(PLANE_PUBLISH_INPUT_PATH));
    if (!dir.isDirectory() || dir.isSymbolicLink()) return undefined;
    // O_NOFOLLOW refuses a link as the final component; the file must be a regular file of ours and of a sane size.
    const fd = openSync(PLANE_PUBLISH_INPUT_PATH, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > MAX_INPUT_BYTES || (process.getuid !== undefined && st.uid !== process.getuid())) return undefined;
      const buf = Buffer.alloc(st.size);
      let got = 0;
      while (got < st.size) {
        const n = readSync(fd, buf, got, st.size - got, got);
        if (n === 0) break;
        got += n;
      }
      return buf.subarray(0, got).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    // fx-swallow-ok: an unreadable input is the same closed answer as a malformed one
    return undefined;
  }
}

async function main(): Promise<void> {
  const say = (line: string): void => void process.stdout.write(`${line}\n`);
  const raw = readInput();
  const input = raw === undefined ? undefined : parsePlanePublishInput(raw);
  if (input === undefined) {
    say(phaseLine({ phase: "refused", code: "bad_input" }));
    return;
  }
  await runPlanePublish(input, { gitOrigin: "https://github.com", apiOrigin: "https://api.github.com", say });
}

main().catch(() => {
  // fx-swallow-ok: nothing about the failure is printed (it can carry an address); the missing terminal line and the exit code say it
  process.stderr.write("fx-plane-publish: failed\n");
  process.exitCode = 1;
});
