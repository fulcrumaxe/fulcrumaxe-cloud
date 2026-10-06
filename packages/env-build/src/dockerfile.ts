import type { Layer } from "@fx/env-presets";
import { EnvBuildError } from "./errors.js";

/** Exec-form JSON array: the argv is never concatenated into a shell string. */
const runLine = (argv: readonly string[]): string => `RUN ${JSON.stringify(argv)}`;

const HEREDOC = "FX_EOF";

/**
 * Everything before the preset layers: the digest-pinned base, the locale and shell (matching Vercel's
 * upstream ubuntu image: `ENV LANG=C.UTF-8`, `ENV SHELL=/bin/bash`), then an OS upgrade. The upgrade changes
 * image content over time, never this text; replay uses the recorded digest.
 */
export function renderHeader(baseRef: string): string[] {
  return [
    `FROM ${baseRef}`,
    "ENV LANG=C.UTF-8",
    "ENV SHELL=/bin/bash",
    "ARG DEBIAN_FRONTEND=noninteractive",
    runLine(["apt-get", "update"]),
    runLine(["apt-get", "upgrade", "-y"]),
  ];
}

/** Packages, then files, then steps: the order Layer documents. */
export function renderLayer(layer: Layer): string[] {
  const out = [`# layer ${layer.id}`];
  if (layer.aptPackages.length > 0) out.push(runLine(["apt-get", "install", "-y", "--no-install-recommends", ...layer.aptPackages]));
  for (const f of layer.files) {
    const body = f.content.endsWith("\n") ? f.content : `${f.content}\n`;
    if (body.split("\n").includes(HEREDOC)) throw new EnvBuildError("invalid_layer_file", "layer file content collides with the heredoc delimiter");
    out.push(`COPY --chmod=${f.mode} <<'${HEREDOC}' ${f.path}`, `${body}${HEREDOC}`);
  }
  for (const [k, v] of Object.entries(layer.env ?? {})) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k) || /[\s"\\$\n]/.test(v.replaceAll("${PATH}", ""))) throw new EnvBuildError("invalid_layer_env", `layer ${layer.id} has an env entry that is not a plain literal`);
    out.push(`ENV ${k}="${v}"`);
  }
  for (const s of layer.steps) out.push(runLine(s));
  return out;
}

/** The user, home and working directory the sandbox runs commands with. No ENTRYPOINT, no CMD. */
export const renderFooter = (rt: { user: string; home: string; workdir: string }): string[] => [
  `ENV HOME=${rt.home}`,
  `USER ${rt.user}`,
  `WORKDIR ${rt.workdir}`,
];
