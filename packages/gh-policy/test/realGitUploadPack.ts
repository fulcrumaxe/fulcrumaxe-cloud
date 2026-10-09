/**
 * Test-only: capture the request bodies the REAL installed git sends to a
 * smart-HTTP server. The server runs `git upload-pack --stateless-rpc`, so the
 * exchange is a genuine one. Never hand-written pkt-lines.
 */
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

const run = promisify(execFile);

export interface CapturedPost {
  protocol: string;
  /** The bytes as sent on the wire. */
  raw: Uint8Array;
  gzipped: boolean;
  /** The bytes after inflating. */
  inflated: Uint8Array;
}

function gitEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
}

export interface RealGit {
  /** Runs git in `cwd` (or the scratch root). */
  git(args: string[], cwd?: string): Promise<string>;
  root: string;
  source: string;
  posts: CapturedPost[];
  url: string;
  close(): Promise<void>;
}

export async function startRealGit(): Promise<RealGit> {
  const root = mkdtempSync(join(tmpdir(), "fx-gh-policy-realgit-"));
  const env = gitEnv(root);
  const git = async (args: string[], cwd = root): Promise<string> =>
    (await run("git", args, { cwd, env })).stdout;
  const source = join(root, "source.git");
  await git(["init", "--bare", "-q", "-b", "main", source]);
  const posts: CapturedPost[] = [];

  const server = createServer((req, res) => {
    const protocol = String(req.headers["git-protocol"] ?? "");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const gitEnvForServer = { ...env, GIT_PROTOCOL: protocol };
    if (req.method === "GET" && url.pathname.endsWith("/info/refs")) {
      const child = spawn("git", ["upload-pack", "--stateless-rpc", "--advertise-refs", source], { env: gitEnvForServer });
      res.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" });
      if (!protocol.includes("version=2")) res.write("001e# service=git-upload-pack\n0000");
      child.stdout.pipe(res);
      return;
    }
    if (req.method === "POST" && url.pathname.endsWith("/git-upload-pack")) {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks);
        const gzipped = req.headers["content-encoding"] === "gzip";
        const inflated = gzipped ? gunzipSync(raw) : raw;
        posts.push({ protocol, raw: new Uint8Array(raw), gzipped, inflated: new Uint8Array(inflated) });
        const child = spawn("git", ["upload-pack", "--stateless-rpc", source], { env: gitEnvForServer });
        res.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
        child.stdout.pipe(res);
        child.stdin.end(inflated);
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    git,
    root,
    source,
    posts,
    url: `http://127.0.0.1:${port}/source.git`,
    close: async () => {
      await new Promise<void>((ok) => server.close(() => ok()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}
