/**
 * `fx-runner vm build-image --template fx-agent --image <repository@sha256:...> --out <dir> [--arch amd64|arm64] [--lock <file>] [--guest-dir <dir>]`
 *
 * With no `--arch` it builds both architectures and prints one `rootfs <arch> sha256:<hex>` line for each. The image names no
 * job, no host path and no credential; a job never names an image at all (the job schema has no such field, and a test pins that).
 */
import { readFileSync } from "node:fs";
import { CliError } from "../cliError.js";
import { buildImage, type BuildHost } from "./buildImage.js";
import { ARCHES, TEMPLATES, parseLock, type Arch } from "./lock.js";

export const VM_USAGE = "usage: fx-runner vm build-image --template fx-agent --image <repository@sha256:...> --out <dir> [--arch amd64|arm64] [--lock <file>] [--guest-dir <dir>]";
const FLAGS =["template", "image", "out", "arch", "lock", "guest-dir"] as const;

export async function vmCommand(args: readonly string[], host: BuildHost, out: (line: string) => void): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "build-image" && rest.includes("--help")) {
    out(VM_USAGE);
    return 0;
  }
  if (sub !== "build-image") throw new CliError(VM_USAGE, 2);
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i]?.startsWith("--") ? rest[i]!.slice(2) : "";
    const value = rest[i + 1];
    if (!(FLAGS as readonly string[]).includes(name) || value === undefined || value.startsWith("--") || flags.has(name)) throw new CliError("build-image: bad or repeated option", 2);
    flags.set(name, value);
  }
  const template = flags.get("template");
  if (template === undefined || !(TEMPLATES as readonly string[]).includes(template)) throw new CliError(`--template must be one of ${TEMPLATES.join(", ")}`, 2);
  const arch = flags.get("arch");
  if (arch !== undefined && !(ARCHES as readonly string[]).includes(arch)) throw new CliError(`--arch must be one of ${ARCHES.join(", ")}`, 2);
  const image = flags.get("image");
  const outDir = flags.get("out");
  if (image === undefined || outDir === undefined) throw new CliError("--image and --out are required", 2);
  let lockText: string;
  try {
    lockText = readFileSync(flags.get("lock") ?? "infra/microvm-image/lock.json", "utf8");
  } catch {
    // fx-swallow-ok: a fixed sentence replaces the node error, which carries the path
    throw new CliError("the image lock could not be read; run from the repository root or pass --lock", 2);
  }
  const built = await buildImage({ lock: parseLock(lockText), image, arches: arch === undefined ? ARCHES : [arch as Arch], outDir, guestDir: flags.get("guest-dir") ?? "infra/microvm-image/guest", host });
  for (const b of built) out(`rootfs ${b.arch} sha256:${b.sha256} size ${b.size}`);
  const first = built[0];
  if (first !== undefined) out(`agent sha256:${first.agentSha256}\ninit sha256:${first.initSha256}\nmke2fs ${first.mke2fs}`);
  return 0;
}
