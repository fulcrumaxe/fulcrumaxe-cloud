#!/usr/bin/env node
// The release manifest for a microVM image (D#587 B-1): one { target, sha256, size } entry for each file the guest boots from
// (kernel, root disk, agent), in the form tuf-release.mjs `release --manifest` signs. A file is named by its own digest, so a released
// file is never replaced, and the boot gate (src/vm/bootGate.ts) finds a digest by name.
//
//   node scripts/vm-manifest.mjs --template fx-agent --out <dir> --file kernel:amd64=<path> --file rootfs:amd64=<path> --file agent:amd64=<path> ...
//
// It copies each file to <dir>/<tag>/<kind>-<arch>-<sha256> (the layout of a release: the tag, then the asset, which is also the layout
// `tuf-release.mjs check --artifacts <dir>` expects), writes <dir>/vm-manifest.json, and prints the tag, which is `vm-<template>-` and the
// first 12 hex digits of the digest of the sorted entry digests. No date, path or host name goes in, so the same files give the same tag.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KINDS = ["kernel", "rootfs", "agent"];
const ARCHES = ["amd64", "arm64"];

export function vmManifest({ template, files, outDir }) {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(template)) throw new Error("template must be a short lower-case name");
  if (files.length === 0) throw new Error("no files given");
  const entries = files.map(({ kind, arch, file }) => {
    if (!KINDS.includes(kind) || !ARCHES.includes(arch)) throw new Error(`unknown kind or arch: ${String(kind).slice(0, 20)}:${String(arch).slice(0, 20)}`);
    const bytes = readFileSync(file);
    if (bytes.length === 0) throw new Error(`${kind}:${arch} is empty`);
    return { kind, arch, file, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
  });
  const names = entries.map((e) => `${e.kind}-${e.arch}-${e.sha256}`);
  if (new Set(names).size !== names.length) throw new Error("the same kind, arch and digest was given twice");
  const tag = `vm-${template}-${createHash("sha256").update([...names].sort().join("\n")).digest("hex").slice(0, 12)}`;
  mkdirSync(path.join(outDir, tag), { recursive: true });
  const manifest = entries.map((e, i) => {
    copyFileSync(e.file, path.join(outDir, tag, names[i]));
    return { target: `${tag}/${names[i]}`, sha256: e.sha256, size: e.size };
  });
  writeFileSync(path.join(outDir, "vm-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { tag, manifest };
}

function main(argv) {
  const files = [];
  let template;
  let outDir;
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${argv[i]} needs a value`);
    if (argv[i] === "--template") template = value;
    else if (argv[i] === "--out") outDir = value;
    else if (argv[i] === "--file") {
      const m = /^(\w+):(\w+)=(.+)$/.exec(value);
      if (m === null) throw new Error("--file takes <kind>:<arch>=<path>");
      files.push({ kind: m[1], arch: m[2], file: m[3] });
    } else throw new Error(`unknown argument at position ${i + 1}`);
  }
  if (template === undefined || outDir === undefined) throw new Error("--template and --out are required");
  process.stdout.write(`${vmManifest({ template, files, outDir }).tag}\n`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`vm-manifest: ${error instanceof Error ? error.message : "failed"}\n`);
    process.exitCode = 1;
  }
}
