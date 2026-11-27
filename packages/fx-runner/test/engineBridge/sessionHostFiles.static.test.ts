import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * D#845 ON-14a (Ruling 120.1): the host never opens an engine file for a session repository. A repository the registry names has no state directory on this machine; its events and its command outcomes are read through the session's channel, and
 * what the runner writes for it is its own cursors and replay state under its own directory. These are the sources of that path, read as text: none of them can name an engine file or a host directory, and the only file calls they make are the runner's own.
 */
const SRC = path.resolve(__dirname, "../../src");
const read = (rel: string): string => readFileSync(path.join(SRC, rel), "utf8");
const SESSION_PATH = ["engineBridge/sessionUnit.ts", "engineBridge/channelTail.ts", "engineBridge/channelInbox.ts", "engineSession/registry.ts"];
const FORBIDDEN = [/ENGINE_EVENTS_FILE/, /HOST_EVENTS_FILE/, /engine-events\.jsonl/, /engine-host-events/, /state_dir/, /repo_root/, /createBridgeTails/, /readEngineVersion/, /openPlain/, /bridge-state/, /createReadStream|readFileSync|openSync|readSync|readdirSync/];

/** The text of one function of the daemon, from its declaration to the next one at the same indent. */
function daemonFunction(name: string): string {
  const text = read("engineBridge/daemon.ts");
  const from = text.indexOf(`function ${name}(`);
  expect(from, name).toBeGreaterThan(-1);
  const next = text.indexOf("\n  function ", from + 1);
  const nextAsync = text.indexOf("\n  async function ", from + 1);
  const end = Math.min(...[next, nextAsync].filter((i) => i > -1), text.length);
  return text.slice(from, end);
}

describe("the session path opens no engine file and names no host directory", () => {
  for (const file of SESSION_PATH) {
    it(`${file}`, () => {
      const text = read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const pattern of FORBIDDEN) expect(text, `${file} must not match ${String(pattern)}`).not.toMatch(pattern);
    });
  }

  it("the channel tail gives the file tail's reader no path at all", () => {
    expect(read("engineBridge/channelTail.ts")).toContain('eventsPath: ""');
  });

  it("the daemon's session functions name neither a state directory nor an engine file, and never start the host's keeper, halt path or bridge state", () => {
    for (const name of ["startSession", "superviseSessions"]) {
      const body = daemonFunction(name).replace(/^\s*\/\/.*$/gm, "");
      for (const pattern of [/state_dir:\s*[^"]/, /\.state_dir/, /repo_root/, /ENGINE_EVENTS_FILE/, /HOST_EVENTS_FILE/, /ports\./, /writeBridgeState|removeBridgeState/, /readEngineVersion/]) expect(body, `${name} must not match ${String(pattern)}`).not.toMatch(pattern);
    }
  });

  it("the session branch of the daemon's stopUnit and the tail's remote poll name no engine file or host directory either", () => {
    const stop = daemonFunction("stopUnit");
    const from = stop.indexOf("if (unit.session !== undefined) {");
    expect(from).toBeGreaterThan(-1);
    const branch = stop.slice(from, stop.indexOf("return;", from)).replace(/^\s*\/\/.*$/gm, "");
    const tail = read("engineBridge/tail.ts");
    const at = tail.indexOf("async pollRemote(");
    expect(at).toBeGreaterThan(-1);
    const remote = tail.slice(at, tail.indexOf("\n  private scanBuffer(", at)).replace(/^\s*\/\/.*$/gm, "");
    for (const [name, body] of [["stopUnit session branch", branch], ["EngineTail.pollRemote", remote]] as const) {
      expect(body.length, name).toBeGreaterThan(100);
      for (const pattern of [...FORBIDDEN, /\.state_dir/, /\bbridgeStatePath\b/, /eventsPath/, /removeBridgeState/]) expect(body, `${name} must not match ${String(pattern)}`).not.toMatch(pattern);
    }
  });

  it("the only filesystem calls the session path makes are the runner's own cursor, replay-state and detail files", () => {
    const calls = (file: string): string[] => [...read(file).replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/\b(mkdirSync|lstatSync|rmSync|saveTextAtomic|loadCursor|saveCursor)\(/g)].map((m) => m[1]!);
    expect(new Set(calls("engineBridge/channelInbox.ts"))).toEqual(new Set(["mkdirSync", "lstatSync", "loadCursor", "saveTextAtomic"]));
    expect(new Set(calls("engineBridge/sessionUnit.ts"))).toEqual(new Set(["rmSync", "loadCursor"]));
    // the removed files are cursors named by the repository's id, under the runner's own directory
    expect(read("engineBridge/sessionUnit.ts")).toMatch(/removeSessionCursors[\s\S]*cursorOf\(runnerStateDir, repoGhId, "engine"\)[\s\S]*outcomes-offset\.json/);
  });
});
