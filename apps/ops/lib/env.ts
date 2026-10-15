import { OPS_ENV_MANIFEST, type Check } from "../env-manifest";

export interface EnvProblem {
  /** The variable's name. Never its value. */
  name: string;
  reason: "missing" | "invalid";
}

type Env = Readonly<Record<string, string | undefined>>;

function valid(check: Check, value: string): boolean {
  switch (check) {
    case "postgres-url":
      return /^postgres(ql)?:\/\//.test(value);
    case "min-chars-32":
      return value.length >= 32;
    case "origin":
      try {
        const u = new URL(value);
        return u.origin === value && (u.protocol === "https:" || u.hostname === "localhost");
      } catch {
        // fx-swallow-ok: an origin that does not parse is reported as invalid just below
        return false;
      }
    case "https-url":
      return /^https:\/\//.test(value);
    case "email":
      return /^[^@\s]+@[^@\s]+$/.test(value);
    case "any":
      return true;
  }
}

/** The required settings that are missing (blank counts as missing) or malformed, by name only. */
export function envProblems(env: Env = process.env): EnvProblem[] {
  const out: EnvProblem[] = [];
  for (const v of OPS_ENV_MANIFEST) {
    if (!v.required) continue;
    const raw = env[v.name];
    if (raw === undefined || raw.trim() === "") out.push({ name: v.name, reason: "missing" });
    else if (!valid(v.check, raw)) out.push({ name: v.name, reason: "invalid" });
  }
  return out;
}

/** The console's origin, or undefined when unset. */
export function opsOrigin(env: Env = process.env): string | undefined {
  const raw = env.FX_OPS_ORIGIN;
  return raw && raw.trim() !== "" ? raw : undefined;
}

/** The WebAuthn relying-party id: the origin's host name. */
export function rpIdOf(origin: string): string {
  return new URL(origin).hostname;
}
