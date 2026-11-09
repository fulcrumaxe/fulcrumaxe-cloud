import { afterEach, describe, expect, it } from "vitest";
import { existsSync, linkSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FX_RECORDER_SCRIPT, RECORDER_MAX_LINE_BYTES, RECORDER_KILL_GRACE_MS, RECORDER_PIPE_WAIT_MS } from "../src/agentConfig.js";
import { MAX_EVENT_LINE_CHARS } from "../src/vercelSandboxPort.js";
import { RECORD_READ_CAP, evaluateRead } from "../src/recordParser.js";
import { alive, nodeCmd, recorderDir, runRecorder, startRecorder, until } from "./helpers/recorderHarness.js";

/** D#2 RLR-3a: the real recorder script, spawned with node, over real children. */
const dirs: ReturnType<typeof recorderDir>[] = [];
const mk = (): ReturnType<typeof recorderDir> => { const d = recorderDir(); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) dirs.pop()!.done(); });
const pidOf = (f: string): number => Number(readFileSync(f, "utf8").trim());

describe("recorder: framing and exits", () => {
  it("frames each line, echoes the same bytes, and ends with a trailer carrying the child's code", async () => {
    const d = mk();
    const r = await runRecorder(d, nodeCmd('process.stdout.write("hello\\nworld\\n")'));
    expect(r.code).toBe(0);
    expect(r.parsed.stop).toBeNull();
    expect(r.parsed.records.map((x) => x.kind)).toEqual(["h", "o", "o", "x"]);
    expect(r.parsed.records.slice(1, 3).map((x) => x.data.toString())).toEqual(["hello", "world"]);
    expect(r.parsed.trailer).toEqual({ seq: 3, code: 0, sig: null, lines: 2, bytes: 12 });
    expect(r.echo.equals(r.file)).toBe(true);
    expect((statSync(d.rec).mode & 0o777).toString(8)).toBe("600");
  });

  it("carries a non-zero exit, a crash by signal and a failed spawn into the trailer and the exit status", async () => {
    const a = mk();
    const exit3 = await runRecorder(a, nodeCmd('process.stdout.write("x\\n"); process.exit(3)'));
    expect([exit3.code, exit3.parsed.trailer?.code, exit3.parsed.trailer?.sig]).toEqual([3, 3, null]);

    const b = mk();
    const crash = await runRecorder(b, nodeCmd('process.stdout.write("before\\n"); process.kill(process.pid, "SIGKILL")'));
    expect([crash.code, crash.parsed.trailer?.code, crash.parsed.trailer?.sig]).toEqual([137, null, "SIGKILL"]);
    expect(crash.parsed.records.map((x) => x.kind)).toEqual(["h", "o", "x"]);

    const c = mk();
    const nospawn = await runRecorder(c, ["/nonexistent/fx-recorder-test"]);
    expect([nospawn.code, nospawn.parsed.trailer?.code]).toEqual([127, 127]);
    expect(nospawn.err).toContain("spawn failed");
  });

  it("keeps an oversize line out of the file, counts it, and keeps going", async () => {
    const d = mk();
    const js = `const M=${RECORDER_MAX_LINE_BYTES};
      process.stdout.write("a".repeat(M)+"\\n");           // exactly the cap: kept
      process.stdout.write("b".repeat(M+1)+"\\n");         // one over: big
      for (let i=0;i<5;i++) process.stdout.write("c".repeat(300000)); process.stdout.write("\\n"); // over, in chunks
      process.stdout.write("after\\n");
      process.stdout.write("d".repeat(M+5));               // oversize, never terminated`;
    const r = await runRecorder(d, nodeCmd(js));
    expect(r.parsed.stop).toBeNull();
    const rows = r.parsed.records.map((x) => [x.kind, x.n]);
    expect(rows).toEqual([["h", 0], ["o", RECORDER_MAX_LINE_BYTES], ["big", RECORDER_MAX_LINE_BYTES + 1], ["big", 1_500_000], ["o", 5], ["big", RECORDER_MAX_LINE_BYTES + 5], ["x", 0]]);
    expect(r.parsed.trailer?.lines).toBe(5);
    expect(r.file.length).toBeLessThan(4_000_000);
  });

  it("flushes an unterminated last fragment as a tail record, before the trailer", async () => {
    const d = mk();
    const r = await runRecorder(d, nodeCmd('process.stdout.write("one\\ntwo-no-newline")'));
    expect(r.parsed.records.map((x) => [x.kind, x.data.toString()])).toEqual([["h", ""], ["o", "one"], ["tail", "two-no-newline"], ["x", ""]]);
  });

  it("writes ASCII only, echoes the same record lines, and gives the child's bytes back exactly", async () => {
    const d = mk();
    const js = `const w=(b)=>process.stdout.write(Buffer.from(b));
      w(Buffer.from("emoji \\u{1F600} caf\\u00e9 \\u65e5\\u672c\\n"));
      w([0x61,0xff,0xfe,0x0a]);                                  // not UTF-8
      w(Buffer.from("lit \\ufffd rep\\n")); w([0x7f,0x01,0x0a]);   // U+FFFD itself, DEL, SOH
      const e=Buffer.from("\\u{1F600}\\u{1F600}\\n"); w(e.subarray(0,2)); setTimeout(()=>w(e.subarray(2)),60);  // a char split across chunks`;
    const r = await runRecorder(d, nodeCmd(js));
    expect(r.file.every((b) => b < 0x80)).toBe(true);
    expect(r.echo.every((b) => b < 0x80)).toBe(true);
    expect(r.echo.equals(r.file)).toBe(true);
    const lines = r.parsed.records.filter((x) => x.kind === "o").map((x) => x.data);
    expect(lines).toEqual([
      Buffer.from("emoji \u{1F600} café 日本"),
      Buffer.from([0x61, 0xff, 0xfe]),
      Buffer.from("lit � rep"),
      Buffer.from([0x7f, 0x01]),
      Buffer.from("\u{1F600}\u{1F600}"),
    ]);
  });

  it("writes the largest possible record inside the read cap", async () => {
    const d = mk();
    const r = await runRecorder(d, nodeCmd(`process.stdout.write(Buffer.alloc(${RECORDER_MAX_LINE_BYTES}, 1)); process.stdout.write("\\n")`));
    const rec = r.parsed.records[1]!;
    expect([rec.kind, rec.n]).toEqual(["o", RECORDER_MAX_LINE_BYTES]);
    expect(rec.size).toBeGreaterThan(6 * RECORDER_MAX_LINE_BYTES);
    expect(rec.size).toBeLessThan(RECORD_READ_CAP);
    // a read of the whole file with the real cap accepts it
    const out = Buffer.concat([r.file, Buffer.from([0xff]), Buffer.from(`@${r.file.length}`)]);
    expect(evaluateRead(out, { offset: 0, nextSeq: 0 }).records.length).toBe(3);
  });
});

describe("recorder: pipes and O_EXCL", () => {
  it("pipes the child's stderr through itself, so a dead recorder cannot leave the command running", async () => {
    const d = mk();
    const forward = await runRecorder(d, nodeCmd('process.stderr.write("to-stderr\\n")'));
    expect(forward.err).toContain("to-stderr");
    expect(forward.file.toString()).not.toContain("to-stderr");

    // The child kills the recorder, then lives on quietly for 4 s. The command's streams must still close at once.
    const e = mk();
    const pidFile = join(e.dir, "orphan.pid");
    const js = `require("fs").writeFileSync(process.argv[1], String(process.pid)); process.kill(process.ppid, "SIGKILL"); setTimeout(()=>{}, 4000)`;
    const r = startRecorder(e, nodeCmd(js, pidFile));
    const end = await r.closed;
    const orphan = pidOf(pidFile);
    try {
      expect(end.ms).toBeLessThan(2500);
      expect(alive(orphan)).toBe(true); // the orphan outlives the recorder, as the spike found: only stop() ends it
      expect(readFileSync(e.rec, "utf8")).not.toContain('"k":"x"'); // and there is no trailer
    } finally {
      process.kill(orphan, "SIGKILL");
    }
  });

  it("finishes within the pipe wait when an escaped grandchild keeps the stdout pipe open", async () => {
    const d = mk();
    const pidFile = join(d.dir, "orphan.pid");
    const js = `const {spawn}=require("child_process");
      const g=spawn(process.execPath,["-e","setTimeout(()=>{},6000)"],{detached:true,stdio:["ignore","inherit","ignore"]});
      g.unref(); require("fs").writeFileSync(process.argv[1], String(g.pid)); process.stdout.write("bye\\n")`;
    const r = await runRecorder(d, nodeCmd(js, pidFile));
    expect(r.ms).toBeLessThan(RECORDER_PIPE_WAIT_MS + 1500);
    expect([r.code, r.parsed.trailer?.code, r.parsed.records.map((x) => x.kind).join("")]).toEqual([0, 0, "hox"]);
  });

  it("refuses a record path that already exists, is a dangling symlink or is a hard link, and runs nothing", async () => {
    const mark = (d: { dir: string }): string => join(d.dir, "ran");
    const js = (d: { dir: string }): string[] => nodeCmd(`require("fs").writeFileSync(${JSON.stringify(mark(d))}, "x")`);

    const a = mk();
    writeFileSync(a.rec, "planted\n");
    const ra = await runRecorder(a, js(a));
    expect([ra.code, readFileSync(a.rec, "utf8"), existsSync(mark(a))]).toEqual([98, "planted\n", false]);

    const b = mk();
    const target = join(b.dir, "victim");
    symlinkSync(target, b.rec);
    expect((await runRecorder(b, js(b))).code).toBe(98);
    expect([existsSync(target), existsSync(mark(b))]).toEqual([false, false]);

    const c = mk();
    const other = join(c.dir, "other");
    writeFileSync(other, "theirs\n");
    linkSync(other, c.rec);
    expect((await runRecorder(c, js(c))).code).toBe(98);
    expect([readFileSync(other, "utf8"), existsSync(mark(c))]).toEqual(["theirs\n", false]);
  });

  it("exits 96 on a malformed command line", async () => {
    const d = mk();
    const r = await runRecorder(d, []);
    expect(r.code).toBe(96);
    expect(existsSync(d.rec)).toBe(false);
  });
});

describe("recorder: signals", () => {
  /** A child that prints, starts a grandchild in its group, and records both pids. */
  const tree = (d: { dir: string }, ignoreTerm: boolean): { cmd: string[]; kid: string } => {
    const kid = join(d.dir, "kid.pid"); // the child writes kid.pid.child too; the harness reaps both
    const grand = ignoreTerm ? `process.on("SIGTERM",()=>{});setInterval(()=>{},1000)` : "setInterval(()=>{},1000)";
    const js = `const {spawn}=require("child_process"),fs=require("fs");
      ${ignoreTerm ? 'process.on("SIGTERM",()=>{});' : ""}
      const g=spawn(process.execPath,["-e",${JSON.stringify(grand)}],{stdio:"ignore"});
      fs.writeFileSync(process.argv[1] + ".child", String(process.pid)); fs.writeFileSync(process.argv[1], String(g.pid)); process.stdout.write("up\\n"); setInterval(()=>{},1000)`;
    return { cmd: nodeCmd(js, kid), kid };
  };

  it("forwards SIGTERM to the child's whole group and records the signal", async () => {
    const d = mk();
    const { cmd, kid } = tree(d, false);
    const r = startRecorder(d, cmd);
    await until(() => existsSync(kid) && r.out().includes("up"));
    const grand = pidOf(kid);
    r.proc.kill("SIGTERM");
    const end = await r.closed;
    const p = r.out();
    expect(end.code).toBe(143);
    const tr = JSON.parse(p.toString().trim().split("\n").pop()!);
    expect([tr.k, tr.code, tr.sig, tr.lines]).toEqual(["x", null, "SIGTERM", 1]);
    await until(() => !alive(grand));
    expect(end.ms).toBeLessThan(RECORDER_KILL_GRACE_MS);
  });

  it("sends SIGKILL to the group after the grace period when the child ignores SIGTERM", async () => {
    const d = mk();
    const { cmd, kid } = tree(d, true);
    const r = startRecorder(d, cmd);
    await until(() => existsSync(kid) && r.out().includes("up"));
    const grand = pidOf(kid);
    const t0 = Date.now();
    r.proc.kill("SIGTERM");
    const end = await r.closed;
    const waited = Date.now() - t0;
    const tr = JSON.parse(r.out().toString().trim().split("\n").pop()!);
    expect([end.code, tr.sig]).toEqual([137, "SIGKILL"]);
    expect(waited).toBeGreaterThanOrEqual(RECORDER_KILL_GRACE_MS - 200);
    expect(waited).toBeLessThan(RECORDER_KILL_GRACE_MS + 3000);
    await until(() => !alive(grand));
  }, 20000);

  it("a SIGKILLed recorder leaves no trailer (the reader's missing-trailer case)", async () => {
    const d = mk();
    const r = startRecorder(d, nodeCmd('process.stdout.write("a\\n"); setInterval(()=>{process.stdout.write("b\\n")}, 20)'));
    await until(() => r.out().length > 40);
    r.proc.kill("SIGKILL");
    await r.closed;
    const file = readFileSync(d.rec, "utf8");
    expect(file).not.toContain('"k":"x"');
    expect(file.startsWith('{"s":0,"k":"h"')).toBe(true);
  });
});

describe("recorder constants", () => {
  it("keeps the cap equal to the event line cap and the script free of template markers", () => {
    expect(RECORDER_MAX_LINE_BYTES).toBe(MAX_EVENT_LINE_CHARS);
    expect(RECORD_READ_CAP).toBeGreaterThan(6 * RECORDER_MAX_LINE_BYTES + 256);
    expect(FX_RECORDER_SCRIPT).not.toMatch(/\$\{|`/);
  });
});
