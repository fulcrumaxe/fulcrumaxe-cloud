import { describe, expect, it } from "vitest";
import { renderMemorySlot, type MemoryEntry } from "../../src/prompt/assemblePrompt.js";
import { PERSON_FLOOR_SHARE, selectWithPersonFloor } from "../../src/prompt/memoryRecall.js";

/** D#601: a person's own lines keep room in a slot that agent, import and receipt lines would otherwise fill. */
const entry = (id: string, size: number, origin: MemoryEntry["origin"]): MemoryEntry => ({ id, version: 1, name: id, origin, text: `${id} ${"w".repeat(size)}` });
const bytes = (list: readonly MemoryEntry[], budget: number): number => Buffer.byteLength(renderMemorySlot(list, budget).text, "utf8");
const ids = (list: readonly MemoryEntry[]): string[] => list.map((e) => e.id).sort();

describe("selectWithPersonFloor", () => {
  it("everything fits: everything is used", () => {
    const all = [entry("a1", 100, "agent"), entry("p1", 100, "person"), entry("i1", 100, "import")];
    expect(ids(selectWithPersonFloor(all, 4096))).toEqual(["a1", "i1", "p1"]);
  });

  it("agent lines ranked first cannot crowd out a person's lines: the person's lines get the first half", () => {
    const budget = 2048;
    const agents = Array.from({ length: 30 }, (_, i) => entry(`a${String(i).padStart(2, "0")}`, 200, "agent"));
    const people = [entry("p1", 200, "person"), entry("p2", 200, "person")];
    // The agent lines come first in rank, as an item-scoped or better-ranked set would.
    const chosen = selectWithPersonFloor([...agents, ...people], budget);
    expect(ids(chosen.filter((e) => e.origin === "person"))).toEqual(["p1", "p2"]);
    expect(chosen.some((e) => e.origin === "agent")).toBe(true);
    expect(bytes(chosen, budget)).toBeLessThanOrEqual(budget);
    expect(renderMemorySlot(chosen, budget).trimmedBytes).toBe(0);
  });

  it("receipts and imports count as the rest, not as a person", () => {
    const budget = 1500;
    const others = [entry("r1", 400, "agent"), entry("r2", 400, "agent"), entry("m1", 400, "import")];
    const chosen = selectWithPersonFloor([...others, entry("p1", 300, "person"), entry("p2", 200, "person")], budget);
    expect(ids(chosen.filter((e) => e.origin === "person"))).toEqual(["p1", "p2"]);
  });

  it("the person's lines are held to about half while others want the room, so the others are not shut out either", () => {
    const budget = 2048;
    const people = Array.from({ length: 20 }, (_, i) => entry(`p${String(i).padStart(2, "0")}`, 200, "person"));
    const agents = Array.from({ length: 20 }, (_, i) => entry(`a${String(i).padStart(2, "0")}`, 200, "agent"));
    const chosen = selectWithPersonFloor([...people, ...agents], budget);
    expect(chosen.some((e) => e.origin === "agent")).toBe(true);
    expect(chosen.filter((e) => e.origin === "person").length).toBeLessThan(people.length);
    expect(bytes(chosen, budget)).toBeLessThanOrEqual(budget);
  });

  it("room the person's lines do not use goes to the others (spill toward agents)", () => {
    const budget = 2048;
    const agents = Array.from({ length: 30 }, (_, i) => entry(`a${String(i).padStart(2, "0")}`, 100, "agent"));
    const chosen = selectWithPersonFloor([entry("p1", 50, "person"), ...agents], budget);
    const agentBytes = bytes(chosen.filter((e) => e.origin !== "person"), budget);
    // Far more than the half that would be left if the person's floor were reserved whole.
    expect(agentBytes).toBeGreaterThan(budget * (1 - PERSON_FLOOR_SHARE));
    expect(ids(chosen)).toContain("p1");
  });

  it("room the others do not use goes to the person's lines (spill toward people)", () => {
    const budget = 2048;
    const people = Array.from({ length: 30 }, (_, i) => entry(`p${String(i).padStart(2, "0")}`, 100, "person"));
    const chosen = selectWithPersonFloor([...people, entry("a1", 50, "agent")], budget);
    const personBytes = bytes(chosen.filter((e) => e.origin === "person"), budget);
    expect(personBytes).toBeGreaterThan(budget * PERSON_FLOOR_SHARE);
    expect(ids(chosen)).toContain("a1");
    expect(bytes(chosen, budget)).toBeLessThanOrEqual(budget);
  });

  it("a person's line too big for the slot is skipped, not cut, and a smaller one still gets in; nothing and zero budget are empty", () => {
    expect(ids(selectWithPersonFloor([entry("big", 5000, "person"), entry("small", 10, "person"), entry("a", 5000, "agent")], 1024))).toEqual(["small"]);
    expect(selectWithPersonFloor([], 4096)).toEqual([]);
    expect(selectWithPersonFloor([entry("a", 10, "person")], 0)).toEqual([]);
  });

  it("the same set gives the same selection however it is ordered within each origin by rank, and renders in id order", () => {
    const budget = 1024;
    const set = [entry("a1", 300, "agent"), entry("a2", 300, "agent"), entry("p1", 300, "person"), entry("p2", 300, "person")];
    const chosen = selectWithPersonFloor(set, budget);
    expect(renderMemorySlot(chosen, budget).trimmedBytes).toBe(0);
    expect(chosen.map((e) => e.id)).toEqual([...chosen].sort((x, y) => ((x.origin === "person" ? 0 : 1) - (y.origin === "person" ? 0 : 1)) || (x.id < y.id ? -1 : 1)).map((e) => e.id));
  });
});
