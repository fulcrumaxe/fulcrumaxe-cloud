import { CORE_SCHEMA, load } from "js-yaml";
import { EnvSpecError, type Path } from "./errors.js";
import { normalize, type EnvSpec } from "./spec.js";
import { LIMITS, validate } from "./validate.js";

export type ParseResult = { ok: true; spec: EnvSpec } | { ok: false; error: EnvSpecError };

const UNSAFE = "anchors, aliases and merge keys are not allowed";

/**
 * Anchors, aliases and merge keys (billion-laughs) are refused outright rather than expanded under a limit.
 * Detection comes from js-yaml itself: its node listener sees every node in every position (explicit `? &a`
 * keys and a document-start anchor included), and an alias cannot exist without an anchor, so the first anchor
 * aborts the parse. The text is searched only afterwards, to report a line.
 */
class AnchorSeen extends Error {
  constructor(readonly anchor: string, readonly fallbackLine: number) {
    super(UNSAFE);
  }
}

function anchorLine(text: string, anchor: string, fallback: number): number {
  const esc = anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const at = new RegExp(`(^|[\\s\\[{,?:-])&${esc}(?=[\\s,\\]}]|$)`, "m").exec(text);
  return at ? text.slice(0, at.index + at[1]!.length).split("\n").length : fallback;
}

function guard(v: unknown, path: Path, depth: number, n: { c: number }): void {
  if (++n.c > LIMITS.nodes) throw new EnvSpecError("limit_exceeded", path, `document has more than ${LIMITS.nodes} nodes`);
  if (depth > LIMITS.depth) throw new EnvSpecError("limit_exceeded", path, `nesting deeper than ${LIMITS.depth}`);
  if (typeof v === "object" && v !== null) {
    for (const [k, c] of Object.entries(v)) {
      if (k === "<<") throw new EnvSpecError("yaml_unsafe", [...path, k], UNSAFE);
      guard(c, [...path, Array.isArray(v) ? Number(k) : k], depth + 1, n);
    }
  }
}

/** Best-effort 1-based line of the deepest segment of `path` that can be found in the text. */
function locate(text: string, path: Path): number | null {
  const lines = text.split("\n");
  let from = 0;
  let found: number | null = null;
  for (const seg of path) {
    let hit = -1;
    if (typeof seg === "string") {
      const key = new RegExp(`^\\s*(-\\s+)*["']?${seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*:`);
      hit = lines.findIndex((l, i) => i >= from && key.test(l));
    } else {
      let n = seg;
      let indent = -1;
      for (let i = from; i < lines.length && hit < 0; i++) {
        const m = /^(\s*)-\s/.exec(lines[i] ?? "");
        if (m && (indent < 0 || m[1]!.length === indent) && (indent = m[1]!.length) >= 0 && n-- === 0) hit = i;
      }
    }
    if (hit < 0) break;
    found = hit + 1;
    from = hit;
  }
  return found;
}

/** Parses `.fulcrumaxe/env.yaml` text into the canonical EnvSpec, or a typed error naming the field and line. */
export function parse(yamlText: string): ParseResult {
  try {
    if (typeof yamlText !== "string" || Buffer.byteLength(yamlText) > LIMITS.bytes) throw new EnvSpecError("limit_exceeded", [], `document must be text of at most ${LIMITS.bytes} bytes`);
    let doc: unknown;
    try {
      doc = load(yamlText, {
        schema: CORE_SCHEMA,
        listener: (phase, state) => {
          if (phase === "close" && state.anchor !== null) throw new AnchorSeen(state.anchor, state.line + 1);
        },
      });
    } catch (e) {
      if (e instanceof AnchorSeen) throw new EnvSpecError("yaml_unsafe", [], UNSAFE, anchorLine(yamlText, e.anchor, e.fallbackLine));
      const mark = (e as { mark?: { line: number } | null }).mark;
      throw new EnvSpecError("yaml_syntax", [], (e as { reason?: string }).reason ?? "not valid YAML (or nested too deeply)", mark ? mark.line + 1 : null);
    }
    guard(doc, [], 0, { c: 0 });
    return { ok: true, spec: normalize(validate(doc ?? {})) };
  } catch (e) {
    if (!(e instanceof EnvSpecError)) throw e;
    e.line ??= locate(yamlText, e.path);
    return { ok: false, error: e };
  }
}
