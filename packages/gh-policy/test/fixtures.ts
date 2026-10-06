/** Test-only helpers for building git smart-HTTP pkt-line request bodies. */

export function encodePktLine(content: string): Uint8Array {
  const bytes = new TextEncoder().encode(content);
  const totalLen = bytes.length + 4;
  const lenHex = totalLen.toString(16).padStart(4, "0");
  const lenBytes = new TextEncoder().encode(lenHex);
  const out = new Uint8Array(lenBytes.length + bytes.length);
  out.set(lenBytes, 0);
  out.set(bytes, lenBytes.length);
  return out;
}

export function encodeFlushPkt(): Uint8Array {
  return new TextEncoder().encode("0000");
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Build a well-formed, properly-terminated `git-receive-pack` request body. */
export function buildReceivePackBody(
  updates: { old: string; new: string; ref: string }[],
): Uint8Array {
  const lines = updates.map((u, i) => {
    const core = `${u.old} ${u.new} ${u.ref}`;
    const line = i === 0 ? `${core}\0report-status\n` : `${core}\n`;
    return encodePktLine(line);
  });
  return concatBytes([...lines, encodeFlushPkt()]);
}

/**
 * Build a `git-receive-pack` body that never reaches a flush-pkt — as if
 * the connection was cut mid-push. `parseReceivePackRefUpdates` must return
 * `complete: false` for this, not silently treat the ref updates it did
 * see as the whole story.
 */
export function buildUnterminatedReceivePackBody(
  updates: { old: string; new: string; ref: string }[],
): Uint8Array {
  const lines = updates.map((u, i) => {
    const core = `${u.old} ${u.new} ${u.ref}`;
    const line = i === 0 ? `${core}\0report-status\n` : `${core}\n`;
    return encodePktLine(line);
  });
  return concatBytes(lines); // deliberately no flush-pkt
}

/**
 * Build a `git-receive-pack` body with one or more `shallow <sha>` lines
 * (as a client pushing from a shallow clone sends) ahead of the ref-update
 * commands, properly terminated with a flush-pkt.
 */
export function buildReceivePackBodyWithShallow(
  shallowShas: string[],
  updates: { old: string; new: string; ref: string }[],
): Uint8Array {
  const shallowLines = shallowShas.map((sha) => encodePktLine(`shallow ${sha}\n`));
  const updateLines = updates.map((u, i) => {
    const core = `${u.old} ${u.new} ${u.ref}`;
    const line = i === 0 ? `${core}\0report-status\n` : `${core}\n`;
    return encodePktLine(line);
  });
  return concatBytes([...shallowLines, ...updateLines, encodeFlushPkt()]);
}

export const ZERO_SHA = "0".repeat(40);
export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);
