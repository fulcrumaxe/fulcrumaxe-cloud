import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ENGINE_COMMAND_PURPOSE,
  EngineCommand,
  EngineCommandAck,
  EngineCommandsPullRequest,
  EngineDecideReply,
  EngineDecideRequest,
  jwkThumbprint,
  signEngineCommand,
  verifyRunnerRequest,
  type Ed25519Jwk,
  type JobKeyring,
} from "@fulcrumaxe/runner-protocol";

/**
 * A stand-in for the cloud's engine command routes, over real HTTP and built to the contract (not to what the runner sends): only POST; every request carries
 * the runner's RFC 9421 signature, checked with `verifyRunnerRequest` against a trusted key, each nonce once (401); bodies go through the protocol's strict
 * schemas (400); a pull answers the commands queued for the asked repos above `after_seq`, signed, with the repos' controls, and marks them delivered;
 * an ack for a delivered command is stored once (a second is 409, an unknown id 404); decide answers what a test sets. Signing uses a key pair made here,
 * whose public half is `keyring`. What it cannot do: the database, row security and the real wake route.
 */
export interface FakeCommands {
  origin: string;
  keyring: JobKeyring;
  /** The runner id the commands are made out to. */
  runnerId: string;
  /** Commands waiting for a pull, unsigned. */
  queue: EngineCommand[];
  controls: Map<number, { halt_epoch: number; halted: boolean; operate_enabled: boolean }>;
  delivered: Set<string>;
  acks: Array<{ id: string; ack: EngineCommandAck }>;
  pulls: Array<{ repo_gh_ids: number[]; after_seq: Record<string, number> }>;
  decides: EngineDecideRequest[];
  decideAnswer: { status: number; body: unknown };
  /** Consumed one per request, before the contract's own answer. */
  faults: Array<{ status: number; body?: unknown } | "drop">;
  /** Replaces what a pull's `commands` holds (to send garbage). */
  pullOverride: (() => unknown[]) | undefined;
  now: () => Date;
  trust(jwk: Ed25519Jwk): void;
  command(repoGhId: number, seq: number, over?: Partial<EngineCommand>): EngineCommand;
  sign(command: EngineCommand): unknown;
  /** A second key pair's signature over the same command, as if the cloud's key were another. */
  signWithStranger(command: EngineCommand): unknown;
  close(): Promise<void>;
}

export async function startFakeCommands(): Promise<FakeCommands> {
  const pair = generateKeyPairSync("ed25519");
  const stranger = generateKeyPairSync("ed25519");
  const keys = new Map<string, Ed25519Jwk>();
  const nonces = new Set<string>();
  const KEY_ID = "cmd-key-1";
  const fake: FakeCommands = {
    origin: "",
    keyring: { [KEY_ID]: pair.publicKey.export({ format: "jwk" }) as { kty: "OKP"; crv: "Ed25519"; x: string } },
    runnerId: randomUUID(),
    queue: [],
    controls: new Map(),
    delivered: new Set(),
    acks: [],
    pulls: [],
    decides: [],
    decideAnswer: { status: 200, body: { disposition: "act", receipt_id: null, ask_id: null, answered: null, halted: false } },
    faults: [],
    pullOverride: undefined,
    now: () => new Date(),
    trust: (jwk) => void keys.set(jwkThumbprint(jwk), jwk),
    command: (repoGhId, seq, over = {}) => {
      const issued = fake.now();
      return {
        v: 1,
        purpose: ENGINE_COMMAND_PURPOSE,
        command_id: randomUUID(),
        command_seq: seq,
        runner_id: fake.runnerId,
        repo_gh_id: repoGhId,
        kind: "pause_loop",
        args: {},
        issued_by: randomUUID(),
        issued_at: issued.toISOString(),
        expires_at: new Date(issued.getTime() + 600_000).toISOString(),
        halt_epoch: 0,
        ...over,
      } as EngineCommand;
    },
    sign: (command) => signEngineCommand(command, KEY_ID, pair.privateKey as KeyObject),
    signWithStranger: (command) => signEngineCommand(command, KEY_ID, stranger.privateKey as KeyObject),
    close: () => new Promise<void>((resolve) => (server as Server).close(() => resolve())),
  };
  const reply = (res: ServerResponse, status: number, body: unknown): void => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const url = req.url ?? "";
    const pull = url === "/api/runner/engine/commands/pull";
    const ack = /^\/api\/runner\/engine\/commands\/([0-9a-f-]{36})\/ack$/.exec(url);
    const decide = url === "/api/runner/engine/decide";
    if (req.method !== "POST" || !(pull || ack !== null || decide)) return reply(res, 404, { error: "not_found" });
    try {
      const verified = await verifyRunnerRequest({ method: "POST", url: `${fake.origin}${url}`, headers: req.headers as Record<string, string | undefined>, body: text }, (keyid) => keys.get(keyid), fake.now());
      if (verified.nonce === undefined || nonces.has(verified.nonce)) return reply(res, 401, { error: "nonce_reused" });
      nonces.add(verified.nonce);
    } catch {
      return reply(res, 401, { error: "unauthorized" });
    }
    const fault = fake.faults.shift();
    if (fault === "drop") return void req.socket.destroy();
    if (fault !== undefined) return reply(res, fault.status, fault.body ?? {});
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return reply(res, 400, { error: "invalid_message" });
    }
    if (pull) {
      const body = EngineCommandsPullRequest.safeParse(json);
      if (!body.success) return reply(res, 400, { error: "invalid_message" });
      fake.pulls.push(body.data);
      const asked = new Set(body.data.repo_gh_ids);
      const due = fake.queue.filter((c) => asked.has(c.repo_gh_id) && c.command_seq > (body.data.after_seq[String(c.repo_gh_id)] ?? 0)).sort((a, b) => a.command_seq - b.command_seq);
      fake.queue = fake.queue.filter((c) => !due.includes(c));
      for (const c of due) fake.delivered.add(c.command_id);
      const controls = body.data.repo_gh_ids.flatMap((id) => (fake.controls.has(id) ? [{ repo_gh_id: id, ...fake.controls.get(id)! }] : []));
      return reply(res, 200, { commands: fake.pullOverride?.() ?? due.map((c) => fake.sign(c)), controls });
    }
    if (ack !== null) {
      const body = EngineCommandAck.safeParse(json);
      if (!body.success) return reply(res, 400, { error: "invalid_message" });
      const id = ack[1]!;
      if (!fake.delivered.has(id)) return reply(res, 404, { error: "not_found" });
      if (fake.acks.some((a) => a.id === id)) return reply(res, 409, { error: "already_acked" });
      fake.acks.push({ id, ack: body.data });
      return reply(res, 200, { command_id: id, state: body.data.outcome });
    }
    const body = EngineDecideRequest.safeParse(json);
    if (!body.success) return reply(res, 400, { error: "invalid_message" });
    fake.decides.push(body.data);
    reply(res, fake.decideAnswer.status, fake.decideAnswer.status === 200 ? EngineDecideReply.parse(fake.decideAnswer.body) : fake.decideAnswer.body);
  }
  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      res.statusCode = 500;
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
