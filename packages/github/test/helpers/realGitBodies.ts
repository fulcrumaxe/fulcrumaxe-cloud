/**
 * Test-only: the request bodies the REAL installed git sends to a smart-HTTP server (D#6 C27 section 5 (b)). Upload-pack bodies come from
 * gh-policy's capture server (`git upload-pack --stateless-rpc` answers); receive-pack bodies come from a server of the same shape here.
 * Nothing is hand-written pkt-lines except where real git cannot produce the shape (a signed push, a delete of the ticket's own ref).
 */
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { startRealGit } from "../../../gh-policy/test/realGitUploadPack.js";

const run = promisify(execFile);
const BRANCHES = 40;

export interface RealGitBodies {
  /** v2 `ls-refs` request (identity). */
  lsRefs: Uint8Array;
  /** v2 `fetch` with wants and no haves, small enough that git sends it uncompressed. */
  fullClone: Uint8Array;
  /** v2 `fetch` of every branch: over 1 KiB, so git sends it gzipped. `raw` is the wire bytes, `inflated` what a server reads. */
  fullCloneGzip: { raw: Uint8Array; inflated: Uint8Array };
  /** v2 `fetch` with `have` lines. */
  fetchWithHave: { raw: Uint8Array; gzipped: boolean };
  /** A push of `branch` (one ref update), and the same push with a push option. */
  push: { branch: string; newOid: string; body: Uint8Array };
  pushWithOption: { branch: string; body: Uint8Array };
  close(): Promise<void>;
}

function gitEnv(home: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
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

/** A receive-pack server that records the bodies it is sent. */
async function receivePackServer(root: string, target: string, env: NodeJS.ProcessEnv) {
  const bodies: Uint8Array[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname.endsWith("/info/refs")) {
      const child = spawn("git", ["receive-pack", "--stateless-rpc", "--advertise-refs", target], { env });
      res.writeHead(200, { "content-type": "application/x-git-receive-pack-advertisement" });
      res.write("001f# service=git-receive-pack\n0000");
      child.stdout.pipe(res);
      return;
    }
    if (req.method === "POST" && url.pathname.endsWith("/git-receive-pack")) {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        bodies.push(new Uint8Array(body));
        const child = spawn("git", ["receive-pack", "--stateless-rpc", target], { env });
        res.writeHead(200, { "content-type": "application/x-git-receive-pack-result" });
        child.stdout.pipe(res);
        child.stdin.end(body);
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { bodies, url: `http://127.0.0.1:${port}/target.git`, close: () => new Promise<void>((ok) => server.close(() => ok())), root };
}

export async function captureRealGitBodies(branch: string, optionBranch: string): Promise<RealGitBodies> {
  const rg = await startRealGit();
  const work = `${rg.root}/work`;
  await rg.git(["init", "-q", "-b", "main", work]);
  await rg.git(["config", "uploadpack.allowAnySHA1InWant", "true"], rg.source);
  await rg.git(["commit", "-q", "--allow-empty", "-m", "root"], work);
  for (let i = 0; i < BRANCHES; i++) {
    await rg.git(["checkout", "-q", "-B", `topic-${i}`, "main"], work);
    await rg.git(["commit", "-q", "--allow-empty", "-m", `topic ${i}`], work);
  }
  await rg.git(["checkout", "-q", "main"], work);
  await rg.git(["push", "-q", rg.source, "--all"], work);

  const clone = async (dest: string, ...extra: string[]) => {
    const before = rg.posts.length;
    await rg.git(["clone", "-q", ...extra, rg.url, `${rg.root}/${dest}`]);
    return rg.posts.slice(before);
  };
  const small = await clone("c-small", "--single-branch", "--branch", "main");
  const all = await clone("c-all");
  const lsRefs = small.find((p) => new TextDecoder().decode(p.inflated.subarray(0, 40)).includes("command=ls-refs"));
  const fullClone = small.find((p) => new TextDecoder().decode(p.inflated.subarray(0, 40)).includes("command=fetch"));
  const gz = all.find((p) => p.gzipped && new TextDecoder().decode(p.inflated.subarray(0, 40)).includes("command=fetch"));

  // Move a branch forward so the next fetch has something to negotiate (it will send `have` lines).
  await rg.git(["checkout", "-q", "topic-0"], work);
  await rg.git(["commit", "-q", "--allow-empty", "-m", "more"], work);
  await rg.git(["push", "-q", rg.source, "--all"], work);
  const before = rg.posts.length;
  await rg.git(["fetch", "-q", "origin"], `${rg.root}/c-all`);
  const withHave = rg.posts.slice(before).find((p) => new TextDecoder().decode(p.inflated).includes("have "));
  if (!lsRefs || !fullClone || fullClone.gzipped || lsRefs.gzipped || !gz || !withHave) throw new Error("realGitBodies: git did not send the expected requests");

  // Receive-pack: a push of one branch, and one with a push option.
  const root = mkdtempSync(join(tmpdir(), "fx-github-realpush-"));
  const env = gitEnv(root);
  const target = join(root, "target.git");
  await run("git", ["init", "--bare", "-q", "-b", "main", target], { cwd: root, env });
  await run("git", ["config", "receive.advertisePushOptions", "true"], { cwd: target, env });
  const server = await receivePackServer(root, target, env);
  const newOid = (await run("git", ["rev-parse", "HEAD"], { cwd: work, env })).stdout.trim();
  await run("git", ["push", "-q", server.url, `HEAD:refs/heads/${branch}`], { cwd: work, env });
  await run("git", ["push", "-q", "-o", "ci.skip=1", server.url, `HEAD:refs/heads/${optionBranch}`], { cwd: work, env });
  const [pushBody, optionBody] = server.bodies;
  if (!pushBody || !optionBody) throw new Error("realGitBodies: git did not push");

  return {
    lsRefs: lsRefs.raw,
    fullClone: fullClone.raw,
    fullCloneGzip: { raw: gz.raw, inflated: gz.inflated },
    fetchWithHave: { raw: withHave.raw, gzipped: withHave.gzipped },
    push: { branch, newOid, body: pushBody },
    pushWithOption: { branch: optionBranch, body: optionBody },
    close: async () => {
      await server.close();
      rmSync(root, { recursive: true, force: true });
      await rg.close();
    },
  };
}
