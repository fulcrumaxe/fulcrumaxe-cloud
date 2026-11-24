// apps/workspace/test/budget-billing-machines.test.mjs
//
// D#845 MC-11b: the Machines card of Budget & billing. The page prints what the API answers and does no arithmetic: money is a decimal string edited as text, token counts are
// separated by string edits, and the dollars come from the server. Drawn against a small stand-in for the DOM calls (there is no jsdom in this package).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("../shell/core/cloud-live.js", () => ({ on: () => () => {}, onRefresh: () => () => {} }));
class FakeNode {}
class FakeText extends FakeNode { constructor(t) { super(); this.text = t; } }
class FakeEl extends FakeNode {
  constructor(tag) { super(); this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.className = ""; }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(t, f) { this.listeners[t] = f; }
  get textContent() { return this.children.map((c) => (c instanceof FakeText ? c.text : c.textContent)).join(""); }
  find(pred, out = []) { if (pred(this)) out.push(this); for (const c of this.children) if (c instanceof FakeEl) c.find(pred, out); return out; }
}
globalThis.Node = FakeNode;
globalThis.document = { createElement: (t) => new FakeEl(t), createTextNode: (t) => new FakeText(t) };
globalThis.window = { FULC: { register: () => {} } };
const { MACHINE_COPY, machineSpendNode, moneyText, tokenText } = await import("../apps/budget-billing/budget-billing-app.js");

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(HERE, "..", "..", "..", "packages", "api", "fixtures", "v1", "getMachineSpend", "200-ok.json"), "utf8"));
const byId = (node, id) => node.find((e) => e.attrs["data-testid"] === id);

describe("string formatting only", () => {
  it("money keeps the server's digits, trims a zero four-decimal tail, and never converts", () => {
    expect(moneyText("12.3400", "EUR")).toBe("€12.34");
    expect(moneyText("12.3456", "EUR")).toBe("€12.3456");
    expect(moneyText("0.0000", "EUR")).toBe("€0.00");
    expect(moneyText("9007199254740993.1000", "EUR")).toBe("€9007199254740993.10");
    expect(moneyText("5.0000", "CHF")).toBe("5.00 CHF");
  });
  it("tokens are grouped without a Number round trip", () => {
    expect(tokenText("1200000")).toBe("1,200,000");
    expect(tokenText("999")).toBe("999");
    expect(tokenText("9007199254740993123")).toBe("9,007,199,254,740,993,123");
  });
});

describe("the card", () => {
  it("prints the fixture exactly: the Hetzner note, the total, the dollars at API prices, a machine and its project", () => {
    const n = machineSpendNode(FIXTURE, {}, {});
    const text = n.textContent;
    expect(byId(n, "bb-servers-total")[0].textContent).toBe("€12.34");
    expect(byId(n, "bb-servers-note")[0].textContent).toBe("Estimated from Hetzner's list price. Hetzner bills you directly.");
    expect(byId(n, "bb-usage-total")[0].textContent).toBe("≈ $4.20 at API prices");
    expect(byId(n, "bb-usage-project")[0].textContent).toContain("acme/site");
    expect(text).not.toContain("%");
    expect(text).not.toMatch(/undefined|null|NaN|\[object/);
  });
  it("empty, loading and failed states", () => {
    const empty = { ...FIXTURE, servers: { ...FIXTURE.servers, servers: [], totals: [] }, usage: { ...FIXTURE.usage, machines: [] } };
    const e = machineSpendNode(empty, {}, {});
    expect(byId(e, "bb-servers-empty")[0].textContent).toBe(MACHINE_COPY.noServers);
    expect(byId(e, "bb-usage-empty")[0].textContent).toBe(MACHINE_COPY.noUsage);
    expect(byId(machineSpendNode(undefined, {}, {}), "bb-machines-loading")).toHaveLength(1);
    let retried = 0;
    const f = machineSpendNode(undefined, { failed: true }, { retry: () => retried++ });
    byId(f, "bb-machines-retry")[0].listeners.click();
    expect(retried).toBe(1);
    expect(byId(machineSpendNode({ hello: 1 }, {}, { retry() {} }), "bb-machines-failed")).toHaveLength(1);
  });
  it("a member gets the server totals and no per-server rows; an estimate is marked", () => {
    const member = { ...FIXTURE, servers: { ...FIXTURE.servers, servers: null } };
    const m = machineSpendNode(member, {}, {});
    expect(byId(m, "bb-servers-total")[0].textContent).toBe("€12.34");
    expect(byId(m, "bb-servers-list")).toHaveLength(0);
    expect(byId(m, "bb-server")).toHaveLength(0);
    expect(byId(m, "bb-servers-empty")).toHaveLength(0);
    expect(byId(m, "bb-machines-failed")).toHaveLength(0);
    expect(m.textContent).not.toContain("build-box");
    const noServers = { ...FIXTURE, servers: { ...FIXTURE.servers, servers: null, totals: [], unpriced_count: 0 } };
    expect(byId(machineSpendNode(noServers, {}, {}), "bb-servers-empty")).toHaveLength(1);
    const est = { ...FIXTURE, servers: { ...FIXTURE.servers, estimate_note: "Estimate: older server", servers: [{ ...FIXTURE.servers.servers[0], estimate: true }] } };
    const e = machineSpendNode(est, {}, {});
    expect(byId(e, "bb-servers-estimate")[0].textContent).toBe("Estimate: older server.");
    expect(byId(e, "bb-server")[0].textContent).toBe("build-box: 481 h, €12.34 (estimate)");
  });
  it("an unpriced model is not zero dollars", () => {
    const part = { ...FIXTURE, usage: { ...FIXTURE.usage, api_equivalent_usd: null, priced: false } };
    expect(byId(machineSpendNode(part, {}, {}), "bb-usage-total")[0].textContent).toBe(MACHINE_COPY.noPrice);
  });
  it("the page source does no arithmetic on money or tokens, and never says a percentage", () => {
    const src = readFileSync(join(HERE, "..", "apps", "budget-billing", "budget-billing-app.js"), "utf8");
    const start = src.indexOf("// ── D#845 MC-11b");
    const section = src.slice(start, src.indexOf("export function mountBudgetBilling"));
    expect(section.length).toBeGreaterThan(500);
    // Comments, strings and the two regex literals (string edits) are taken out; what is left may not convert to a number or use an arithmetic operator.
    const code = section.replace(/\/\/.*$/gm, "").replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\/(?:[^/\n\\]|\\.)+\/g?/g, "re");
    expect(code).not.toMatch(/Number\(|parseFloat|parseInt|Math\.|toFixed|BigInt/);
    expect(code).not.toMatch(/[^=<>!]=[^=>]*\s[*/%]\s|\s[*/]\s|\s-\s[a-z0-9]/);
    expect(section).not.toMatch(/%/);
  });
});
