#!/usr/bin/env node
// D#31 API-5 criterion 11 (the cost seat's packing benchmark):
//
//   node packages/api/bench/sse-packing.mjs --streams 10 --minutes 10
//
// Holds N concurrent SSE streams (half run streams, half account streams)
// against a PRODUCTION build under `next start` and a local Postgres, with
// events written at 1/s per stream, and writes peak RSS, CPU seconds, p95
// latency and dropped events to bench/results/sse-packing.json.
//
// Pass (the 10-stream run is GATED): peak RSS < 2 GB, p95 <= 3 s (or, if
// that is missed with the production settle window, the owner-approved
// fallback p95 <= poll + settle + 1 s = 4 s, recorded as `p95_bar_applied`),
// zero dropped events. The results record the effective FX_EVENTS_SETTLE_MS. Any other stream count (the 50-stream run) is REPORTED,
// not gated. Exit code 1 if a gated run fails.
//
// Prerequisites (the script does not build or provision anything):
//   pnpm --filter web build                          # the production build
//   BENCH_DATABASE_URL=...            a superuser/owner URL of a MIGRATED database
//   BENCH_DATABASE_URL_APP_USER=...   the same database as the app_user role
//   BENCH_DATABASE_URL_PLATFORM_OPS=...  ... as the platform_ops role
// (packages/db/test/support/ephemeral-pg.ts provisions exactly such a
// cluster for the test suites; the PR body shows the invocation used.)
//
// Method notes:
//   - Streams are split evenly: streams/2 run streams (one per running run,
//     each receiving one run_event per second) and streams/2 account
//     streams (each receiving one domain_event per second). A run is left
//     'running' throughout, so the account poll is at its 2 s worst case.
//   - Streams are spread over accounts of at most 10 streams and users of
//     at most 3, so no session cap (3 per user, 25 per account) is hit.
//   - Latency = (client receive time) - (writer's timestamp taken just
//     before the INSERT), on one host, so it includes the poll interval.
//   - RSS/CPU are read from /proc for the `next start` process tree.
//     Peak RSS is the max over 1 s samples of the tree's summed VmRSS.
//   - Stream lifetimes are 720-780 s, so a 10-minute run does not reconnect.
//     A longer --minutes run reconnects with Last-Event-ID, exercising resume;
//     "dropped" counts events the client never received across reconnects.

import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, "..", "..", "..", "apps", "web");
const require = createRequire(import.meta.url);
const pg = require("pg");

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const STREAMS = Number(args.get("streams") ?? 10);
const MINUTES = Number(args.get("minutes") ?? 10);
const PORT = Number(args.get("port") ?? 3417);
const OUT = args.get("out") ?? path.join(__dirname, "results", "sse-packing.json");
const GATED = STREAMS === 10;
if (!Number.isInteger(STREAMS) || STREAMS < 2 || STREAMS % 2 !== 0 || !(MINUTES > 0)) {
  console.error("usage: sse-packing.mjs --streams <even int >= 2> --minutes <n>");
  process.exit(2);
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} must be set (see the header of this file)`);
    process.exit(2);
  }
  return v;
}

// The settle window the SERVER runs with (packages/api/src/sse/poller.ts): held-back events add up to this much
// latency, so the results must say which one produced them. Unset means the production default; the harness
// refuses anything the production floor (1000 ms) would refuse, so a shell that turned the hold-back off cannot
// pass for a production configuration.
const DEFAULT_SETTLE_MS = 1000; // mirrors DEFAULT_SETTLE_MS in poller.ts (pinned by test/sse-fix1.test.ts)
const MIN_SETTLE_MS = 1000; // mirrors MIN_SETTLE_MS
const settleEnv = process.env.FX_EVENTS_SETTLE_MS;
if (settleEnv !== undefined && !(/^[0-9]+$/.test(settleEnv) && Number(settleEnv) >= MIN_SETTLE_MS)) {
  console.error(`FX_EVENTS_SETTLE_MS=${JSON.stringify(settleEnv)} would disable or malform the settle window; unset it (the production default is ${DEFAULT_SETTLE_MS} ms) or use >= ${MIN_SETTLE_MS}`);
  process.exit(2);
}
const SETTLE_MS = settleEnv === undefined ? DEFAULT_SETTLE_MS : Number(settleEnv);
const ACTIVE_POLL_MS = 2000;
// Criterion 11 bar: p95 <= 3 s. Fallback bar (D#31 correction C21, owner-approved): p95 <= poll + settle + 1 s.
const P95_BAR_MS = 3000;
const P95_FALLBACK_BAR_MS = ACTIVE_POLL_MS + SETTLE_MS + 1000;
const ADMIN_URL = requireEnv("BENCH_DATABASE_URL");
const APP_URL = requireEnv("BENCH_DATABASE_URL_APP_USER");
const OPS_URL = requireEnv("BENCH_DATABASE_URL_PLATFORM_OPS");

const SESSION_SECRET = "bench-".padEnd(40, "s");
const CURSOR_KEY = randomBytes(32).toString("base64");

// ---- session cookie: an HS256 JWT exactly as packages/core/src/auth/session.ts verifies it ----
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
function signSession({ userId, accountId }) {
  const now = Date.now();
  const iat = Math.floor(now / 1000);
  const claims = { userId, accountId, sid: randomUUID(), epoch: 0, sessionStart: now, lastSeenAt: now, iat, exp: iat + 24 * 3600 };
  const head = b64({ alg: "HS256" });
  const body = b64(claims);
  const sig = createHmac("sha256", SESSION_SECRET).update(`${head}.${body}`).digest("base64url");
  return `__Host-fx_session=${head}.${body}.${sig}`;
}

// ---- /proc sampling of the server's process tree ----
function children(pid) {
  const out = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (ppid === pid) out.push(Number(entry));
    } catch {
      /* raced with exit */
    }
  }
  return out;
}
function tree(pid) {
  const all = [pid];
  for (let i = 0; i < all.length; i++) all.push(...children(all[i]));
  return all;
}
function procStats(pid) {
  let rssKb = 0;
  let hwmKb = 0;
  let ticks = 0;
  for (const p of tree(pid)) {
    try {
      const status = readFileSync(`/proc/${p}/status`, "utf8");
      rssKb += Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
      hwmKb += Number(/VmHWM:\s+(\d+)/.exec(status)?.[1] ?? 0);
      const stat = readFileSync(`/proc/${p}/stat`, "utf8");
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      ticks += Number(f[11]) + Number(f[12]); // utime + stime
    } catch {
      /* exited */
    }
  }
  return { rssKb, hwmKb, cpuSeconds: ticks / 100 };
}

// ---- SSE client ----
class Stream {
  constructor(name, url, cookie, kind) {
    this.name = name;
    this.url = url;
    this.cookie = cookie;
    this.kind = kind;
    this.lastEventId = null;
    this.received = new Map(); // key -> latency ms
    this.order = [];
    this.reconnects = 0;
    this.status = 0;
    this.closed = false;
    this.controller = null;
  }
  async run(onOpen) {
    for (;;) {
      if (this.closed) return;
      this.controller = new AbortController();
      const headers = { accept: "text/event-stream", cookie: this.cookie };
      if (this.lastEventId) headers["last-event-id"] = this.lastEventId;
      let res;
      try {
        res = await fetch(this.url, { headers, signal: this.controller.signal });
      } catch {
        if (this.closed) return;
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      this.status = res.status;
      if (res.status !== 200) {
        const text = await res.text();
        throw new Error(`${this.name}: HTTP ${res.status} ${text.slice(0, 200)}`);
      }
      onOpen();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for await (const chunk of res.body) {
          buf += decoder.decode(chunk, { stream: true });
          for (;;) {
            const end = buf.indexOf("\n\n");
            if (end === -1) break;
            const raw = buf.slice(0, end);
            buf = buf.slice(end + 2);
            this.handle(raw);
          }
        }
      } catch {
        /* aborted or reset */
      }
      if (this.closed) return;
      this.reconnects++;
    }
  }
  handle(raw) {
    const now = Date.now();
    let id;
    let event;
    let data;
    for (const line of raw.split("\n")) {
      if (line.startsWith("id: ")) id = line.slice(4);
      else if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (id !== undefined) this.lastEventId = id;
    if (event === undefined || data === undefined) return;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    let sentAt;
    let key;
    if (this.kind === "run" && event === "run_event") {
      sentAt = parsed.payload?.t;
      key = `seq:${parsed.seq}`;
    } else if (this.kind === "account" && event === "bench.tick") {
      sentAt = Number(String(parsed.data?.stage ?? "").replace(/^t/, ""));
      key = `evt:${parsed.id}`;
    } else {
      return;
    }
    if (!Number.isFinite(sentAt) || this.received.has(key)) return;
    this.received.set(key, now - sentAt);
    this.order.push(key);
  }
  close() {
    this.closed = true;
    this.controller?.abort();
  }
}

const percentile = (sorted, p) => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]);

async function main() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();

  // ---- seed: accounts of <= 10 streams; users of <= 3 streams; one running run per run stream ----
  const runStreams = STREAMS / 2;
  const accountStreams = STREAMS / 2;
  const plan = []; // {kind, accountId, userId, runId?}
  const accounts = [];
  let remainingRun = runStreams;
  let remainingAcct = accountStreams;
  while (remainingRun + remainingAcct > 0) {
    const accountId = randomUUID();
    await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'scale', $2, 'active')`, [accountId, `cus_bench_${accountId}`]);
    const account = { accountId, runs: [], users: [] };
    accounts.push(account);
    const runs = Math.min(5, remainingRun);
    const accts = Math.min(5, remainingAcct);
    remainingRun -= runs;
    remainingAcct -= accts;
    const users = [];
    for (let u = 0; u < Math.ceil((runs + accts) / 3); u++) {
      const userId = randomUUID();
      await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@bench.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [accountId, userId]);
      users.push(userId);
    }
    account.users = users;
    let slot = 0;
    for (let i = 0; i < accts; i++) plan.push({ kind: "account", accountId, userId: users[Math.floor(slot++ / 3)] });
    for (let i = 0; i < runs; i++) {
      const runId = randomUUID();
      await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'build', 'local', 'running')`, [runId, accountId]);
      account.runs.push({ runId, seq: 0 });
      plan.push({ kind: "run", accountId, userId: users[Math.floor(slot++ / 3)], runId });
    }
  }

  // ---- the server under test: a production build under `next start` ----
  if (!existsSync(path.join(webDir, ".next", "BUILD_ID"))) {
    console.error("no production build: run `pnpm --filter web build` first");
    process.exit(2);
  }
  const nextBin = require.resolve("next/dist/bin/next", { paths: [webDir] });
  const server = spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], {
    cwd: webDir,
    env: {
      ...process.env,
      NODE_ENV: "production",
      ...(settleEnv === undefined ? {} : { FX_EVENTS_SETTLE_MS: settleEnv }),
      DATABASE_URL_APP_USER: APP_URL,
      DATABASE_URL_PLATFORM_OPS: OPS_URL,
      FX_SESSION_SECRET: SESSION_SECRET,
      FX_CURSOR_KEY_V1: CURSOR_KEY,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`${base}/api/v1/openapi.json`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (i > 120) throw new Error(`next start did not come up:\n${serverLog}`);
    await new Promise((r) => setTimeout(r, 500));
  }

  const streams = plan.map((p, i) => {
    const cookie = signSession({ userId: p.userId, accountId: p.accountId });
    const url = p.kind === "account" ? `${base}/api/v1/events` : `${base}/api/v1/runs/${p.runId}/events`;
    return new Stream(`${p.kind}-${i}`, url, cookie, p.kind);
  });

  let opened = 0;
  let allOpen;
  const allOpenPromise = new Promise((r) => (allOpen = r));
  const runs = streams.map((s) =>
    s.run(() => {
      if (++opened === streams.length) allOpen();
    }),
  );
  runs.forEach((r) => r.catch((e) => {
    console.error(e);
    process.exit(1);
  }));
  await Promise.race([allOpenPromise, new Promise((_, rej) => setTimeout(() => rej(new Error("streams did not all open")), 60_000))]);
  await new Promise((r) => setTimeout(r, 3000)); // let the pollers settle before measuring

  const leasesWhileOpen = Number((await admin.query(`SELECT count(*)::int AS n FROM stream_leases`)).rows[0].n);
  const base0 = procStats(server.pid);
  let peakRssKb = 0;
  const sampler = setInterval(() => {
    peakRssKb = Math.max(peakRssKb, procStats(server.pid).rssKb);
  }, 1000);

  // ---- the writer: 1 event/s per stream ----
  const writerEvery = 1000;
  const totalTicks = Math.round((MINUTES * 60 * 1000) / writerEvery);
  let writerErrors = 0;
  const started = Date.now();
  for (let tick = 0; tick < totalTicks; tick++) {
    const due = started + tick * writerEvery;
    const wait = due - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      for (const account of accounts) {
        const t = Date.now();
        await admin.query(`INSERT INTO domain_events (account_id, type, payload) VALUES ($1, 'bench.tick', $2::jsonb)`, [
          account.accountId,
          JSON.stringify({ stage: `t${t}` }),
        ]);
        for (const run of account.runs) {
          run.seq += 1;
          await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, $3, 'bench', $4::jsonb)`, [
            account.accountId,
            run.runId,
            run.seq,
            JSON.stringify({ t: Date.now() }),
          ]);
        }
      }
    } catch (e) {
      writerErrors++;
      console.error("writer error", e.message);
    }
  }
  await new Promise((r) => setTimeout(r, 5000)); // drain the last poll interval
  clearInterval(sampler);
  const end = procStats(server.pid);
  peakRssKb = Math.max(peakRssKb, end.rssKb);

  // ---- tally ----
  // The database is the source of truth for what each stream should have received.
  let expected = 0;
  let received = 0;
  let outOfOrder = 0;
  const latencies = [];
  for (const s of streams) latencies.push(...s.received.values());
  for (let i = 0; i < streams.length; i++) {
    // Ordering: a run stream's seq must be strictly increasing in arrival order.
    let last = 0;
    for (const key of streams[i].order) {
      if (!key.startsWith("seq:")) continue;
      const n = Number(key.slice(4));
      if (n <= last) outOfOrder++;
      last = n;
    }
  }
  let expectedFromDb = 0;
  let receivedFromDb = 0;
  for (let i = 0; i < streams.length; i++) {
    const p = plan[i];
    if (p.kind !== "account") continue;
    const { rows } = await admin.query(`SELECT id FROM domain_events WHERE account_id = $1 AND type = 'bench.tick'`, [p.accountId]);
    expectedFromDb += rows.length;
    for (const r of rows) if (streams[i].received.has(`evt:${r.id}`)) receivedFromDb++;
  }
  let runExpected = 0;
  let runReceived = 0;
  for (let i = 0; i < streams.length; i++) {
    const p = plan[i];
    if (p.kind !== "run") continue;
    const { rows } = await admin.query(`SELECT seq FROM run_events WHERE run_id = $1`, [p.runId]);
    runExpected += rows.length;
    for (const r of rows) if (streams[i].received.has(`seq:${r.seq}`)) runReceived++;
  }
  expected = expectedFromDb + runExpected;
  received = receivedFromDb + runReceived;
  const dropped = expected - received;

  latencies.sort((a, b) => a - b);
  const result = {
    streams: STREAMS,
    run_streams: runStreams,
    account_streams: accountStreams,
    minutes: MINUTES,
    events_per_second_per_stream: 1,
    gated: GATED,
    peak_rss_mb: Math.round((peakRssKb / 1024) * 10) / 10,
    peak_rss_hwm_mb: Math.round((end.hwmKb / 1024) * 10) / 10,
    baseline_rss_mb: Math.round((base0.rssKb / 1024) * 10) / 10,
    cpu_seconds: Math.round((end.cpuSeconds - base0.cpuSeconds) * 100) / 100,
    p50_latency_ms: percentile(latencies, 50),
    p95_latency_ms: percentile(latencies, 95),
    max_latency_ms: latencies.length ? latencies[latencies.length - 1] : null,
    expected_events: expected,
    received_events: received,
    dropped_events: dropped,
    out_of_order_events: outOfOrder,
    reconnects: streams.reduce((n, s) => n + s.reconnects, 0),
    writer_errors: writerErrors,
    thresholds: {
      peak_rss_mb_lt: 2048,
      p95_latency_ms_lte: P95_BAR_MS,
      p95_latency_ms_fallback_lte: P95_FALLBACK_BAR_MS,
      dropped_events_eq: 0,
    },
    p95_bar_applied: null,
    settle_ms: SETTLE_MS,
    fx_events_settle_ms_env: settleEnv ?? null,
    pass: null,
    environment: {
      node: process.version,
      cpus: os.cpus().length,
      cpu_model: os.cpus()[0]?.model,
      total_mem_gb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
      platform: `${os.platform()} ${os.release()}`,
      server: "next start (production build), one process",
      database: "local PostgreSQL, app_user / platform_ops pools",
      poll_intervals_ms: { active: 2000, idle: 10000, run: 2000 },
      settle_ms: SETTLE_MS,
      fx_events_settle_ms_env: settleEnv ?? null,
    },
    generated_at: new Date().toISOString(),
  };
  // Which p95 bar this run passed: the criterion's 3 s, else the pre-approved poll + settle + 1 s (C21 1.5), else neither.
  result.p95_bar_applied =
    result.p95_latency_ms === null
      ? "none"
      : result.p95_latency_ms <= P95_BAR_MS
        ? "p95<=3s"
        : result.p95_latency_ms <= P95_FALLBACK_BAR_MS
          ? "fallback: p95<=poll+settle+1s"
          : "none";
  result.pass = result.peak_rss_mb < 2048 && result.p95_bar_applied !== "none" && dropped === 0 && outOfOrder === 0 && writerErrors === 0;

  // Disconnect every client (a real socket close); the server must notice, stop polling and free every lease.
  for (const s of streams) s.close();
  await new Promise((r) => setTimeout(r, 4000));
  result.leases_while_open = leasesWhileOpen;
  result.leases_after_disconnect = Number((await admin.query(`SELECT count(*)::int AS n FROM stream_leases`)).rows[0].n);
  result.pass = result.pass && leasesWhileOpen === STREAMS && result.leases_after_disconnect === 0;
  server.kill("SIGTERM");
  await admin.end();

  // Merge into the results file, keyed by stream count: the gated 10-stream run and the reported 50-stream run live side by side.
  mkdirSync(path.dirname(OUT), { recursive: true });
  let file = { description: "D#31 API-5 criterion 11: SSE packing benchmark. The 10-stream run is gated; other counts are reported.", runs: {} };
  if (existsSync(OUT)) {
    try {
      file = JSON.parse(readFileSync(OUT, "utf8"));
    } catch {
      /* start fresh */
    }
  }
  file.runs[String(STREAMS)] = result;
  writeFileSync(OUT, `${JSON.stringify(file, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (GATED && !result.pass) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
