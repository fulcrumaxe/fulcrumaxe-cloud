import { gzipSync } from "node:zlib";

export interface TarSpec {
  name: string;
  type?: string;
  body?: string;
  mode?: number;
  link?: string;
}

function header(name: string, type: string, size: number, mode: number, link = ""): Buffer {
  const b = Buffer.alloc(512);
  b.write(name.slice(0, 100), 0, "utf8");
  b.write(mode.toString(8).padStart(7, "0"), 100);
  b.write("0000000", 108);
  b.write("0000000", 116);
  b.write(size.toString(8).padStart(11, "0"), 124);
  b.write("00000000000", 136);
  b.fill(0x20, 148, 156);
  b.write(type, 156);
  b.write(link.slice(0, 100), 157);
  b.write("ustar\0" + "00", 257, "latin1");
  let sum = 0;
  for (const x of b) sum += x;
  b.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  return b;
}
const pad = (body: Buffer): Buffer => Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)]);

/** An uncompressed ustar archive of `specs`, ended with two zero blocks. */
export function tarOf(specs: readonly TarSpec[]): Buffer {
  const parts: Buffer[] = [];
  for (const s of specs) {
    const body = Buffer.from(s.body ?? "");
    parts.push(header(s.name, s.type ?? "0", body.length, s.mode ?? 0o644, s.link), pad(body));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export const tgzOf = (specs: readonly TarSpec[]): Buffer => gzipSync(tarOf(specs));

/** The engine's epic template, cut down to the parts a heading reader must get right: a heading inside a code fence and inside a comment is not one. */
export const EPIC_TEMPLATE = [
  "# Epic <N>: <Epic title>",
  "",
  "## Context",
  "",
  "Prose.",
  "",
  "## Architecture",
  "",
  "```",
  "## not a heading, it is inside a fence",
  "```",
  "",
  "## Tasks",
  "",
  "| # | Title |",
  "",
  "<!--",
  "## nor is this one, it is inside a comment",
  "-->",
  "",
].join("\n");

/** A good engine archive as codeload serves it: one top directory and the epic template in it. */
export const engineTgz = (extra: readonly TarSpec[] = []): Buffer =>
  tgzOf([{ name: "engine-abc/", type: "5", mode: 0o755 }, { name: "engine-abc/scripts/coldstart-templates/epic/epic.md", body: EPIC_TEMPLATE }, ...extra]);
