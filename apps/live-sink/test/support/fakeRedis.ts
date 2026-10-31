/**
 * A strict stand-in for the Upstash Redis REST endpoint, with a clock the test moves. It enforces what the adapter relies on:
 * POST to /multi-exec only, the bearer token, a JSON array of string-only commands, EXPIRE with a positive whole number of
 * seconds (NX sets a deadline only when none exists), LRANGE/LTRIM/DEL on lists, and a key that vanishes once its deadline
 * passes. Anything else is an error, as the real service answers. What it cannot fake: TLS and the real service's limits.
 */
export interface FakeRedis {
  /** The adapter's `fetch`, in process. */
  fetch: typeof fetch;
  /** The same endpoint for a real HTTP server: path, method, Authorization header, body text. */
  handle(path: string, method: string, authorization: string | null, body: string): { status: number; json: unknown };
  advance(ms: number): void;
  keys(): string[];
}

export function createFakeRedis(token: string): FakeRedis {
  let now = 0;
  const lists = new Map<string, { items: string[]; expiresAt?: number }>();
  const live = (key: string) => {
    const entry = lists.get(key);
    if (entry?.expiresAt !== undefined && now >= entry.expiresAt) lists.delete(key);
    return lists.get(key);
  };
  function run(command: string[]): unknown {
    const [name, key, ...args] = command as [string, string, ...string[]];
    if (typeof key !== "string") throw new Error("ERR wrong number of arguments");
    switch (name) {
      case "RPUSH": {
        const entry = live(key) ?? { items: [] };
        entry.items.push(...args);
        lists.set(key, entry);
        return entry.items.length;
      }
      case "EXPIRE": {
        const entry = live(key);
        if (!/^[1-9]\d*$/.test(args[0] ?? "") || (args[1] !== undefined && args[1] !== "NX")) throw new Error("ERR invalid expire time");
        if (!entry || (args[1] === "NX" && entry.expiresAt !== undefined)) return 0;
        entry.expiresAt = now + Number(args[0]) * 1000;
        return 1;
      }
      case "LTRIM": {
        const entry = live(key);
        if (!entry) return "OK";
        const [start, stop] = args.map(Number) as [number, number];
        const from = start < 0 ? Math.max(entry.items.length + start, 0) : start;
        entry.items = entry.items.slice(from, (stop < 0 ? entry.items.length + stop : stop) + 1);
        return "OK";
      }
      case "LRANGE":
        if (args.join(" ") !== "0 -1") throw new Error("ERR this fake only reads a whole list");
        return [...(live(key)?.items ?? [])];
      case "DEL":
        return live(key) && lists.delete(key) ? 1 : 0;
      default:
        throw new Error(`ERR unknown command '${name}'`);
    }
  }
  const handle: FakeRedis["handle"] = (path, method, authorization, body) => {
    if (method !== "POST" || new URL(path, "https://redis.test").pathname !== "/multi-exec") return { status: 404, json: { error: "not found" } };
    if (authorization !== `Bearer ${token}`) return { status: 401, json: { error: "WRONGPASS invalid or missing token" } };
    const commands: unknown = JSON.parse(body);
    if (!Array.isArray(commands) || !commands.every((c) => Array.isArray(c) && c.every((a) => typeof a === "string"))) {
      return { status: 400, json: { error: "ERR commands must be arrays of strings" } };
    }
    try {
      return { status: 200, json: (commands as string[][]).map((c) => ({ result: run(c) })) };
    } catch (err) {
      return { status: 400, json: { error: (err as Error).message } };
    }
  };
  return {
    handle,
    fetch: async (input, init) => {
      const { status, json } = handle(String(input), init?.method ?? "GET", new Headers(init?.headers).get("authorization"), String(init?.body ?? ""));
      return new Response(JSON.stringify(json), { status });
    },
    advance: (ms) => void (now += ms),
    keys: () => [...lists.keys()].filter((k) => live(k)),
  };
}
