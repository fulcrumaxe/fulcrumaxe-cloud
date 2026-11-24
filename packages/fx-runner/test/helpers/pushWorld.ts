import { execFile, execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createGit, type Git } from "../../src/daemon/git.js";
import type { SetupPushDeps } from "../../src/setup/setupPush.js";
import { startGitHttpServer, type GitHttpServer } from "./gitHttpServer.js";
import { GIT_ENV, git, scratchDir } from "../vm/workspace/helpers.js";

export const PUSH_TOKEN = "ghs_sentinel_setup_push_token_9f3a7c1d5e";

export interface PushWorld {
  server: GitHttpServer;
  /** The bare repository the server serves as `<owner>/<name>.git`: the stand-in for the customer's GitHub repository. */
  remote: string;
  deps: SetupPushDeps;
  /** Every argument list the runner's git was given, in order; and what the cloud was asked and told. */
  argv: string[][];
  asked: Array<{ setupId: string; jobId: string }>;
  revoked: string[];
  snapshots: string;
  /** Runs `hook` right before the runner's git runs a command whose arguments include `verb` (once). */
  before(verb: string, hook: () => void): void;
  /** The tip of `refs/heads/<branch>` in the remote, or null. */
  tip(branch: string): string | null;
  close(): Promise<void>;
}

/**
 * A stand-in for GitHub for the push, strict where the real host is: a smart-HTTP git server over `git http-backend` (the CGI that ships with git) that answers a push only to HTTP Basic credentials whose password is
 * a token bound to this one repository (401 without, 403 for another repository). The "cloud" hands out that token once and records every ask; revoke is recorded. What it cannot fake: GitHub's branch protection,
 * push rules and rate limits, and TLS (a loopback http origin is the one place the push allows plain http).
 */
export async function pushWorld(o: { seed?: { repo: string; branch: string } | undefined; owner?: string; name?: string; token?: (n: number) => string | undefined } = {}): Promise<PushWorld> {
  const owner = o.owner ?? "acme";
  const name = o.name ?? "Widgets.Service";
  const root = scratchDir("fxw-srv-");
  const remote = path.join(root, owner, `${name}.git`);
  mkdirSync(path.dirname(remote), { recursive: true });
  git(root, "init", "-q", "--bare", remote);
  git(remote, "config", "http.receivepack", "true");
  if (o.seed !== undefined) git(o.seed.repo, "push", "-q", remote, `HEAD:refs/heads/${o.seed.branch}`);
  const server = await startGitHttpServer(root, new Map([[PUSH_TOKEN, [`${owner}/${name}`]]]));
  // asynchronous on purpose: the server below lives in this process, and a synchronous child would stop it answering
  const real = createGit({
    capture: (command, args, env) =>
      new Promise((resolve) => {
        execFile(command, [...args], { env: { ...GIT_ENV(), ...env }, encoding: "utf8", maxBuffer: 1 << 26 }, (error, stdout) => resolve({ code: error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1, stdout, timedOut: false }));
      }),
  });
  const argv: string[][] = [];
  const hooks = new Map<string, () => void>();
  const wrapped: Git = {
    run(code, args, config, timeoutMs, extraEnv) {
      argv.push([...args]);
      for (const [verb, hook] of hooks) {
        if (args.includes(verb)) {
          hooks.delete(verb);
          hook();
        }
      }
      return real.run(code, args, config, timeoutMs, extraEnv);
    },
  };
  const asked: PushWorld["asked"] = [];
  const revoked: string[] = [];
  const snapshots = scratchDir("fxw-snap-");
  const deps: SetupPushDeps = {
    git: wrapped,
    client: {
      async setupPushToken(setupId, jobId) {
        asked.push({ setupId, jobId });
        const token = o.token === undefined ? PUSH_TOKEN : o.token(asked.length);
        return token === undefined ? { kind: "refused", status: 409, code: "already_issued" } : { kind: "token", token, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
      },
    },
    revoke: async (token) => (revoked.push(token), true),
    snapshotsRoot: snapshots,
    remoteUrl: () => `${server.origin}/${owner}/${name}.git`,
  };
  return {
    server,
    remote,
    deps,
    argv,
    asked,
    revoked,
    snapshots,
    before: (verb, hook) => void hooks.set(verb, hook),
    tip: (branch) => {
      try {
        return execFileSync("git", ["--git-dir", remote, "rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        // fx-swallow-ok: a test reads "no such branch" as null
        return null;
      }
    },
    close: () => server.close(),
  };
}
