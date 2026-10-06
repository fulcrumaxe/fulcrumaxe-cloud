/** The body with every pipeline-fenced block (opening line ... closing line) removed: what a reader sees as the pipeline's own text. */
export function outsideFences(body: string): string {
  const out: string[] = [];
  let inside = false;
  for (const line of body.split("\n")) {
    if (!inside && /^`{7}untrusted-\w+$/.test(line)) inside = true;
    else if (inside && /^`{7}$/.test(line)) inside = false;
    else if (!inside) out.push(line);
  }
  if (inside) throw new Error("unclosed pipeline fence");
  return out.join("\n");
}

