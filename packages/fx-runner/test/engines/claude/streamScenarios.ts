import path from "node:path";
import type { LocalOnlyEvent } from "@fulcrumaxe/runner-protocol";
import type { AgentStreamEnd } from "../../../src/engines/claude/streamRun.js";
import { HOST_USAGE_LIMITS, runAgentStream } from "../../../src/engines/claude/streamRun.js";
import { createClaudeEngine, outcomeOf } from "../../../src/engines/claude/engine.js";
import type { JobLimits } from "../../../src/sandbox/jobLimits.js";
import { fixtureText, makeFake } from "./harness.js";
import { makeRig, streamWith } from "./rig.js";

/** One recorded run: what the agent printed, how it ended, and what the memory scope would say. */
export interface Scenario {
  name: string;
  stream: string;
  stderr?: string;
  exitCode?: number;
  exceeded?: boolean;
  /** True when stderr races stdout on the host (the agent is killed while its output is still arriving): only the outcome is compared against the direct path. */
  racy?: boolean;
  /** True when the run has a memory scope to ask. */
  limits?: boolean;
}

const sub = fixtureText("stream.subscription.jsonl");
const tool = fixtureText("stream.tooluse.synthetic.jsonl");
const lines = (text: string): string[] => text.split("\n").filter((line) => line !== "");
const withoutResult = (text: string): string => lines(text).filter((line) => !line.includes('"type":"result"')).join("\n") + "\n";
const isError = (text: string): string => lines(text).map((line) => (line.includes('"type":"result"') ? line.replace('"is_error":false', '"is_error":true') : line)).join("\n") + "\n";

export const SCENARIOS: Scenario[] = [
  { name: "complete subscription run", stream: sub },
  { name: "tool use with structured output", stream: tool },
  { name: "error result", stream: isError(tool) },
  { name: "truncated: no result line", stream: withoutResult(tool), exitCode: 1 },
  { name: "truncated: cut inside the last line", stream: tool.slice(0, tool.length - 40), exitCode: 1 },
  { name: "result seen, then non-zero exit", stream: tool, exitCode: 3 },
  { name: "resource_limit after a kill", stream: withoutResult(tool), exitCode: 137, exceeded: true, limits: true },
  { name: "limit question answered no", stream: withoutResult(tool), exitCode: 137, exceeded: false, limits: true },
  { name: "credential mismatch", stream: streamWith("ANTHROPIC_API_KEY") },
  { name: "no init line", stream: lines(tool).slice(2).join("\n") + "\n", exitCode: 1 },
  { name: "permission mode forced", stream: sub, stderr: "warning: Permission mode forced to default\n", racy: true },
  { name: "unknown option before any line", stream: "", stderr: "error: unknown option '--x'\n", exitCode: 1 },
];

export interface Seen {
  events: unknown[];
  locals: unknown[];
  outcome: unknown;
}

/** Strips what differs between machines and runs (clock stamps, the temporary root), leaving everything else byte for byte. */
export function canonical(seen: Seen, root: string): string {
  const text = JSON.stringify(seen, (key, value) => (key === "ts" ? "<ts>" : value));
  return text.split(root).join("<ROOT>");
}

function limitsFor(scenario: Scenario): JobLimits | undefined {
  if (scenario.limits !== true) return undefined;
  return { wrap: (_job, command, args, env) => ({ command, args: [...args], env }), exceeded: async () => scenario.exceeded === true };
}

export interface HostRun {
  canonical: string;
  root: string;
  workdir: string;
  engineVersion: string;
}

/** The scenario through the host engine, over a real child process. */
export async function viaEngine(scenario: Scenario, engineOf: typeof createClaudeEngine = createClaudeEngine): Promise<HostRun> {
  const locals: LocalOnlyEvent[] = [];
  const rig = makeRig({ fake: makeFake({ stream: scenario.stream }), onLocalEvent: (event) => void locals.push(event) });
  if (scenario.exitCode !== undefined) rig.fake.set("exit-code", String(scenario.exitCode));
  if (scenario.stderr !== undefined) rig.fake.set("stderr.txt", scenario.stderr);
  const limits = limitsFor(scenario);
  if (limits !== undefined) rig.config.limits = limits;
  const opts = rig.startOptions();
  const { handle } = await engineOf(rig.config).start(opts);
  const outcome = await outcomeOf(handle);
  return { canonical: canonical({ events: opts.events, locals, outcome }, rig.root), root: rig.root, workdir: rig.workdir, engineVersion: outcome.engineVersion };
}

/** The same text as an in-memory source, cut into small uneven chunks so line boundaries never line up with chunk boundaries. */
export async function* chunked(text: string, size = 7): AsyncGenerator<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

/** The scenario through `runAgentStream` directly, with the same workdir and version the engine run used. */
export async function viaStream(scenario: Scenario, host: HostRun, end?: AgentStreamEnd): Promise<{ canonical: string; terminated: number }> {
  const events: unknown[] = [];
  const locals: LocalOnlyEvent[] = [];
  const rig = makeRig();
  let terminated = 0;
  const outcome = await runAgentStream({
    options: { ...rig.startOptions(), workdir: host.workdir, onEvent: (event) => void events.push(event) },
    workdir: host.workdir,
    credentials: { mode: "subscription" },
    engineVersion: host.engineVersion,
    usageLimits: HOST_USAGE_LIMITS,
    stdout: chunked(scenario.stream),
    stderr: chunked(scenario.stderr ?? "", 5),
    ended: Promise.resolve(end ?? { code: scenario.exitCode ?? 0, signal: null }),
    terminate: () => void terminated++,
    log: { write: () => undefined },
    onLocalEvent: (event) => void locals.push(event),
    ...(scenario.limits === true ? { resourceLimitExceeded: async () => scenario.exceeded === true } : {}),
  });
  return { canonical: canonical({ events, locals, outcome }, host.root), terminated };
}

export const GOLDEN_FILE = path.join(import.meta.dirname, "golden", "streamRun.golden.json");
