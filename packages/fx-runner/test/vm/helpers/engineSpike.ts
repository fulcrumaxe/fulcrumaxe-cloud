import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * D#845 ON-13b1, the spike gate: does a background Agent survive the end of a turn while the host's stdin stays open? `engineSpike.py` runs the host the way the supervisor will
 * (the same fixed argument vector, one stream-json user message, stdin held open); this file holds the prompt, the guest-side paths and the JUDGE, a pure function over what the script printed, so the
 * verdict is the same for a fake model and for the real one. The real run is `engineSpike.real.test.ts`; the fake is `engineSpike.test.ts`.
 */
export const SPIKE_SCRIPT = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "engineSpike.py"), "utf8");

/**
 * Inside the guest, on its writable workspace root (`/vercel/sandbox` is made for the agent user at every boot; the rest of the image, `/home/ubuntu` included, is read-only).
 * The marker is written by the background Agent only after its own delay, so a marker newer than the turn's end proves it kept running. The host runs with this directory as its cwd, so `.claude/settings.json` under it is its project settings.
 */
export const SPIKE_DIR = "/vercel/sandbox/fx-spike";
export const SPIKE_MARKER = `${SPIKE_DIR}/marker.txt`;
/** The one command that writes the marker. It has its own allow rule because the CLI checks each `&&` part of a command alone and counts a `>` redirect as a file write, so a compound command never matches a rule. */
export const SPIKE_TOUCH = `touch ${SPIKE_MARKER}`;
/** How long the background Agent works before it writes the marker. It must outlast the first turn by a clear margin. */
export const SPIKE_DELAY_S = 45;
/** The marker must be at least this much newer than the first `result` line for the verdict `survived`. */
export const SPIKE_MARGIN_S = 15;
/** How long the host's stdin is held open: the delay, the margin and time for the model's own turn. */
export const SPIKE_HOLD_S = 120;

export const spikePrompt = (): string =>
  `Do exactly this, using no other tools. Start ONE background Agent (the Agent tool with run_in_background true) whose whole task is: run the shell command \`sleep ${SPIKE_DELAY_S}\`, then run \`${SPIKE_TOUCH}\` (the folder already exists), then stop. ` +
  `As soon as the Agent is started, answer the single word started and end your turn. Do not wait for the Agent and do not poll it.`;

/** The project settings of the working directory: the headless host may use exactly these tools without any permission-skipping flag. */
export const SPIKE_SETTINGS = JSON.stringify({ permissions: { allow: ["Agent", `Bash(sleep ${SPIKE_DELAY_S})`, `Bash(${SPIKE_TOUCH})`] } });

export type SpikeVerdict = "survived" | "lost" | "inconclusive";
export interface SpikeReport {
  verdict: SpikeVerdict;
  /** One closed reason (a fixed word, never text from the model). */
  reason: "marker_after_turn" | "no_marker" | "marker_before_turn" | "no_result" | "turn_error" | "permission_denied" | "host_exit_early" | "second_turn_no_marker" | "unreadable";
  /** Seconds between the first `result` line and the marker, when both exist. */
  marker_after_turn_s: number | undefined;
  /** Seconds after the first `result` line at which each `result` line came (the first is 0). */
  turn_s: number[];
  /** The names of the tools refused in any turn (closed: only well-formed tool names, no model text), sorted. */
  refused: string[];
  /** How many `result` lines the stream held (a second one means the finished Agent started another turn by itself). */
  turns: number;
  /** The model names on the `result` lines' `modelUsage`, and the four token totals summed over the `result` lines. */
  models: string[];
  usage: { input: number; output: number; cache_read: number; cache_write: number };
}

/** What the script printed (`L <epoch> <json>`, `M <epoch|none>`, `X <code>`) to a verdict. Anything it cannot read is `inconclusive: unreadable`, never a guess. */
export function judgeSpike(output: string, marginS: number = SPIKE_MARGIN_S): SpikeReport {
  const results: { at: number; json: Record<string, unknown> }[] = [];
  let marker: number | "none" | undefined;
  let exited: string | undefined;
  for (const raw of output.split("\n")) {
    const stream = /^L (\d+(?:\.\d+)?) (.*)$/.exec(raw);
    if (stream !== null) {
      try {
        const json: unknown = JSON.parse(stream[2] as string);
        if (typeof json === "object" && json !== null && (json as Record<string, unknown>)["type"] === "result") results.push({ at: Number(stream[1]), json: json as Record<string, unknown> });
      } catch {
        // fx-swallow-ok: a stream line that is not JSON is not a turn's end; the judge counts only what parses
      }
      continue;
    }
    const m = /^M (none|\d+(?:\.\d+)?)$/.exec(raw);
    if (m !== null) marker = m[1] === "none" ? "none" : Number(m[1]);
    const x = /^X (\S+)$/.exec(raw);
    if (x !== null) exited = x[1];
  }
  const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  const models = new Set<string>();
  const safe = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);
  for (const { json } of results) {
    const u = (json["usage"] ?? {}) as Record<string, unknown>;
    usage.input += safe(u["input_tokens"]);
    usage.output += safe(u["output_tokens"]);
    usage.cache_read += safe(u["cache_read_input_tokens"]);
    usage.cache_write += safe(u["cache_creation_input_tokens"]);
    const byModel = json["modelUsage"];
    if (typeof byModel === "object" && byModel !== null) for (const name of Object.keys(byModel)) if (/^[A-Za-z0-9._:-]{1,64}$/.test(name)) models.add(name);
  }
  const refused = new Set<string>();
  let denied = false;
  for (const { json } of results) {
    const list = json["permission_denials"];
    if (!Array.isArray(list) || list.length === 0) continue;
    denied = true;
    for (const item of list) {
      const name = typeof item === "object" && item !== null ? (item as Record<string, unknown>)["tool_name"] : undefined;
      if (typeof name === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(name)) refused.add(name);
    }
  }
  const t0 = results[0]?.at ?? 0;
  const base = { turns: results.length, turn_s: results.map((r) => Math.round((r.at - t0) * 1000) / 1000), refused: [...refused].sort(), models: [...models].sort(), usage };
  const report = (verdict: SpikeVerdict, reason: SpikeReport["reason"], after?: number): SpikeReport => ({ verdict, reason, marker_after_turn_s: after, ...base });
  if (marker === undefined || exited === undefined) return report("inconclusive", "unreadable");
  const first = results[0];
  if (first === undefined) return report("inconclusive", exited === "0" ? "no_result" : "host_exit_early");
  if (first.json["is_error"] === true) return report("inconclusive", "turn_error");
  if (denied) return report("inconclusive", "permission_denied");
  if (marker === "none") return results.length >= 2 ? report("inconclusive", "second_turn_no_marker") : report("lost", "no_marker");
  const after = Math.round((marker - first.at) * 1000) / 1000;
  return after >= marginS ? report("survived", "marker_after_turn", after) : report("lost", "marker_before_turn", after);
}
