// The run-log recorder script, kept apart from agentConfig.ts: its text names node modules, and agentConfig.ts must hold no such text.

/** A child stdout line over this many bytes becomes a `big` record without its content. Equal to `MAX_EVENT_LINE_CHARS`. */
export const RECORDER_MAX_LINE_BYTES = 1_048_576;
/** After SIGTERM the recorder waits this long, then sends SIGKILL to the child's process group. */
export const RECORDER_KILL_GRACE_MS = 5000;
/** After the child exits the recorder waits this long for its stdout pipe to close (an escaped grandchild may hold it), then goes on. */
export const RECORDER_PIPE_WAIT_MS = 2000;

/**
 * D#2 RLR-3a (run-log reader design, Round 3 B1, amended by the RLR-0c results): the recorder, the agent command's parent.
 * `node recorder.mjs <recordPath> <runId> -- <cmd> [args...]`.
 *
 * It frames each complete stdout line of the child as one JSON record on one line, appended with ONE write() to a file opened
 * O_CREAT|O_EXCL|O_APPEND (an existing path, a symlink or a hard link there makes it exit 98 before anything runs; 98, not the prompt wrapper's 97, so the two refusals can be told apart), and writes
 * the same record line to its own stdout, which nobody reads until the exit cross-check. Records: header `h` (s 0), `o` (n = byte
 * length of the line, d = text, or e "b64" and base64 when the bytes are not valid UTF-8), `big` (a line over the cap, content dropped),
 * `tail` (an unterminated last fragment) and the trailer `x` (code, sig, lines, bytes), always last. Every record ends with `t`, a
 * second copy of its seq: a chunk dropped from the middle of a line can otherwise join the head of one record to the tail of
 * another, and a head `s` with a tail `n` and `d` is a valid wrong record. With `t` the tail's own seq has to match the head's.
 * And the last field is `c`, the first 16 hex digits of the sha256 of the line's text before it: a byte dropped or doubled inside
 * one line (an escape such as \t or \u00e9, a digit of n, a digit of the exit code) breaks it, where `n` alone can still match.
 *
 * Records and echo are ASCII only (non-ASCII is written as \uXXXX): the vendor log path damages multibyte text split across chunks.
 * The child gets the command's stdin, and pipes for stdout and stderr; its stderr is forwarded to ours, so an orphan cannot keep the
 * Vercel command alive after a SIGKILLed recorder. The child runs in its own process group: SIGTERM, SIGINT and SIGHUP are forwarded
 * to the group, SIGKILL follows after the grace period, and the trailer carries the child's code or signal. The script holds no
 * backtick and no dollar-brace, so it is stored as it is.
 */
export const FX_RECORDER_SCRIPT = String.raw`import { openSync, writeSync, constants as K } from "node:fs";
import { constants as OS } from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
const MAX_LINE = ${RECORDER_MAX_LINE_BYTES};
const GRACE_MS = ${RECORDER_KILL_GRACE_MS};
const PIPE_WAIT_MS = ${RECORDER_PIPE_WAIT_MS};
const [recordPath, runId, sep, ...cmd] = process.argv.slice(2);
if (!recordPath || !runId || sep !== "--" || cmd.length === 0) { process.stderr.write("usage: recorder <recordPath> <runId> -- cmd...\n"); process.exit(96); }
let fd;
try { fd = openSync(recordPath, K.O_WRONLY | K.O_CREAT | K.O_EXCL | K.O_APPEND, 0o600); }
catch (e) { process.stderr.write("recorder: cannot create the record file: " + e.code + "\n"); process.exit(98); }
for (const s of [process.stdout, process.stderr]) s.on("error", () => {});
const ascii = (t) => t.replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
const rec = (o) => {
  o.t = o.s;
  const p = ascii(JSON.stringify(o)).slice(0, -1);
  const line = Buffer.from(p + ',"c":"' + createHash("sha256").update(p, "latin1").digest("hex").slice(0, 16) + '"}\n', "latin1");
  for (let off = 0; off < line.length;) off += writeSync(fd, line, off);
  process.stdout.write(line);
};
rec({ s: 0, k: "h", run: runId, v: 1 });
let seq = 0, totalBytes = 0, pending = [], pendingLen = 0, overflow = false, overflowLen = 0;
const emitLine = (buf, kind) => {
  seq++;
  const str = buf.toString("utf8");
  if (Buffer.byteLength(str, "utf8") === buf.length && !str.includes("�")) rec({ s: seq, k: kind, n: buf.length, d: str });
  else rec({ s: seq, k: kind, n: buf.length, e: "b64", d: buf.toString("base64") });
};
const emitBig = (n) => { seq++; rec({ s: seq, k: "big", n }); };
const onData = (chunk) => {
  totalBytes += chunk.length;
  let start = 0, i;
  while ((i = chunk.indexOf(0x0a, start)) >= 0) {
    const part = chunk.subarray(start, i); start = i + 1;
    if (overflow) { emitBig(overflowLen + part.length); overflow = false; overflowLen = 0; continue; }
    const whole = pendingLen ? Buffer.concat([...pending, part]) : part;
    pending = []; pendingLen = 0;
    if (whole.length > MAX_LINE) emitBig(whole.length); else emitLine(whole, "o");
  }
  const rest = chunk.subarray(start);
  if (!rest.length) return;
  if (overflow) overflowLen += rest.length;
  else if (pendingLen + rest.length > MAX_LINE) { overflow = true; overflowLen = pendingLen + rest.length; pending = []; pendingLen = 0; }
  else { pending.push(Buffer.from(rest)); pendingLen += rest.length; }
};
const child = spawn(cmd[0], cmd.slice(1), { stdio: ["inherit", "pipe", "pipe"], detached: true });
let killTimer = null, termSig = null, finished = false, exitInfo = null, pipeEnded = false;
const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch {} };
child.on("error", (e) => { process.stderr.write("recorder: spawn failed: " + e.code + "\n"); finish(127, null); });
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => {
  termSig = sig;
  killGroup(sig);
  if (!killTimer) killTimer = setTimeout(() => killGroup("SIGKILL"), GRACE_MS);
});
child.stderr.pipe(process.stderr, { end: false });
child.stdout.on("data", (c) => {
  onData(c);
  if (process.stdout.writableNeedDrain) { child.stdout.pause(); process.stdout.once("drain", () => child.stdout.resume()); }
});
child.stdout.on("end", () => { pipeEnded = true; maybeFinish(); });
child.on("exit", (code, sig) => {
  exitInfo = { code, sig };
  setTimeout(() => { if (!finished) { child.stdout.destroy(); pipeEnded = true; maybeFinish(); } }, PIPE_WAIT_MS).unref();
  maybeFinish();
});
function maybeFinish() {
  if (finished || !exitInfo || !pipeEnded) return;
  if (overflow) emitBig(overflowLen); else if (pendingLen) emitLine(Buffer.concat(pending), "tail");
  finish(exitInfo.code, exitInfo.sig);
}
function finish(code, sig) {
  if (finished) return;
  finished = true;
  if (killTimer) clearTimeout(killTimer);
  if (termSig) killGroup("SIGKILL");
  seq++;
  rec({ s: seq, k: "x", code, sig, lines: seq - 1, bytes: totalBytes });
  const exitCode = code !== null ? code : sig ? 128 + (OS.signals[sig] ?? 1) : 1;
  process.stdout.write("", () => process.exit(exitCode));
}
`;
