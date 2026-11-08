// apps/workspace/test/pipeline-repo-loader.test.mjs
//
// INBOX-PICKER-STUCK: the Pipeline repository picker must never stay on "Loading repositories…". The read behind it is a
// loader with four states; these tests drive it with a fake read and a fake clock. The DOM half is in e2e/pipeline.spec.ts.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createRepoLoader, getAllPages } from "../apps/pipeline/pipeline-storage.js";

const clock = () => {
  const timers = [];
  return {
    setT: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearT: (id) => {
      if (timers[id - 1]) timers[id - 1].fn = null;
    },
    fire: () =>
      timers.forEach((t) => {
        const f = t.fn;
        t.fn = null;
        if (f) f();
      }),
  };
};
const deferred = () => {
  let ok, no;
  const p = new Promise((a, b) => {
    ok = a;
    no = b;
  });
  return { p, ok, no };
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const setup = (read) => {
  const c = clock();
  const seen = [];
  const loader = createRepoLoader({ read, onChange: (s) => seen.push(s.status), setT: c.setT, clearT: c.clearT, timeoutMs: 20000 });
  return { c, seen, loader };
};

describe("repository loader", () => {
  it("fills after the read succeeds, and answers every later ask without reading again", async () => {
    let reads = 0;
    const { seen, loader } = setup(async () => (reads++, [{ id: "r1", full_name: "a/b" }]));
    loader.ask();
    await tick();
    loader.ask();
    await tick();
    expect(seen).toEqual(["loading", "ready"]);
    expect(reads).toBe(1);
    expect(loader.state().rows).toHaveLength(1);
  });

  it("ready with 0 rows, then forced ask makes a second read and paints", async () => {
    let reads = 0;
    const { seen, loader } = setup(async () => (reads++, reads === 1 ? [] : [{ id: "r1", full_name: "a/b" }]));
    loader.ask();
    await tick();
    loader.ask();
    await tick();
    expect(reads).toBe(1);
    loader.ask({ force: true });
    expect(loader.state().status).toBe("loading");
    await tick();
    expect(reads).toBe(2);
    expect(seen).toEqual(["loading", "ready", "loading", "ready"]);
    expect(loader.state().rows).toHaveLength(1);
  });

  it("a forced ask while a read is running does not start a second read", async () => {
    let reads = 0;
    const { loader } = setup(() => (reads++, new Promise(() => {})));
    loader.ask();
    loader.ask({ force: true });
    expect(reads).toBe(0);
    await tick();
    expect(reads).toBe(1);
  });

  it("reads through getAllPages from a fake /api/v1/repos", async () => {
    const calls = [];
    const get = async (m, url) => (
      calls.push(m + " " + url),
      url.includes("cursor") ? { data: [{ id: "r2", full_name: "c/d" }], next_cursor: null } : { data: [{ id: "r1", full_name: "a/b" }], next_cursor: "n1" }
    );
    const { loader } = setup(() => getAllPages("/api/v1/repos", get));
    loader.ask();
    await tick();
    expect(loader.state().status).toBe("ready");
    expect(loader.state().rows.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(calls).toEqual(["GET /api/v1/repos", "GET /api/v1/repos?cursor=n1"]);
  });

  it("a read that never answers becomes failed at the deadline, so the picker cannot spin forever", async () => {
    const { c, seen, loader } = setup(() => new Promise(() => {}));
    loader.ask();
    await tick();
    expect(loader.state().status).toBe("loading");
    c.fire();
    expect(seen).toEqual(["loading", "failed"]);
  });

  it("a failed read is asked again by the next ask, and a late answer to the first read does not undo the second", async () => {
    const first = deferred();
    const second = deferred();
    const reads = [first, second];
    const { c, loader } = setup(() => reads.shift().p);
    loader.ask();
    c.fire();
    expect(loader.state().status).toBe("failed");
    loader.ask();
    expect(loader.state().status).toBe("loading");
    second.ok([{ id: "r1", full_name: "a/b" }]);
    await tick();
    first.ok([{ id: "stale", full_name: "x/y" }]);
    await tick();
    expect(loader.state().status).toBe("ready");
    expect(loader.state().rows[0].id).toBe("r1");
  });

  it("asking again while a read is running does not start a second read", async () => {
    let reads = 0;
    const { loader } = setup(() => (reads++, new Promise(() => {})));
    loader.ask();
    loader.ask();
    await tick();
    expect(reads).toBe(1);
  });

  it("a rejected read is failed at once", async () => {
    const { seen, loader } = setup(async () => {
      throw new Error("x");
    });
    loader.ask();
    await tick();
    expect(seen).toEqual(["loading", "failed"]);
  });

  // INBOX-PICKER-HANG-2: the deadline timer is lost (a throttled or frozen page) while the read never settles. The loader must not stay "loading" with the
  // "a read is running" guard turning every later ask into a no-op; once the clock says the read is over, the next ask reads again.
  const lostTimers = (read) => {
    let t = 0;
    const seen = [];
    const loader = createRepoLoader({ read, onChange: (s) => seen.push(s.status), setT: () => 1, clearT: () => {}, timeoutMs: 20000, now: () => t });
    return { seen, loader, advance: (ms) => (t += ms) };
  };

  it("a read whose deadline timer was lost is replaced by the next ask once the deadline has passed on the clock", async () => {
    let reads = 0;
    const answers = [new Promise(() => {}), Promise.resolve([{ id: "r1", full_name: "a/b" }])];
    const { loader, advance } = lostTimers(() => answers[reads++]);
    loader.ask();
    await tick();
    expect(reads).toBe(1);
    advance(19999);
    loader.ask();
    await tick();
    expect(reads).toBe(1); // still inside its deadline: left to finish
    advance(1);
    loader.ask();
    await tick();
    expect(reads).toBe(2); // a request is in flight again
    expect(loader.state().status).toBe("ready");
    expect(loader.state().rows.map((r) => r.id)).toEqual(["r1"]);
  });

  it("a stale read that answers after it was replaced does not undo the newer read", async () => {
    const first = deferred();
    const second = deferred();
    const reads = [first, second];
    const { loader, advance } = lostTimers(() => reads.shift().p);
    loader.ask();
    await tick();
    advance(20000);
    loader.ask();
    await tick();
    second.ok([{ id: "new", full_name: "a/b" }]);
    await tick();
    first.ok([{ id: "stale", full_name: "x/y" }]);
    await tick();
    expect(loader.state().rows.map((r) => r.id)).toEqual(["new"]);
  });

  it("reports nothing after destroy", async () => {
    const d = deferred();
    const { c, seen, loader } = setup(() => d.p);
    loader.ask();
    loader.destroy();
    d.ok([]);
    c.fire();
    await tick();
    expect(seen).toEqual(["loading"]);
    loader.ask();
    expect(seen).toEqual(["loading"]);
  });
});

describe("the Pipeline screen uses the loader", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "pipeline", "pipeline-app.js"), "utf8");
  it("has no flag that stops a second read, and does not drop an answer on a closed mount", () => {
    expect(src).not.toMatch(/reposAsked/);
    expect(src).toMatch(/createRepoLoader\(/);
    expect(src).toMatch(/repoLoader\.destroy\(\)/);
    expect(src).toMatch(/repoLoader\.ask\(\{ force: true \}\)/);
    expect(src).toMatch(/repoLoader\.state\(\)\.status !== "ready"/);
    // Coming back to a page that sat in the background asks again, and the listener goes with the mount.
    expect(src).toMatch(/addEventListener\("visibilitychange", onVisible\)/);
    expect(src).toMatch(/removeEventListener\("visibilitychange", onVisible\)/);
  });
});
