/** An argv array, never a shell string (same rule as the env-spec package). */
export type Argv = readonly string[];

/** The nine preset ids, frozen. E4 and the env-spec `preset` field reference these. */
export const PRESET_IDS = ["rust", "go", "jvm", "dotnet", "ruby", "php", "cpp", "node", "python"] as const;
export type PresetId = (typeof PRESET_IDS)[number];

/** A file the layer writes. Content is literal text, never a template. */
export interface LayerFile { readonly path: string; readonly mode: string; readonly content: string }

/**
 * One image layer. `toolchains` names what the layer installs; a layer holds at most one, because the
 * registry rejects a layer over 500 MB compressed. The shared base layer holds none.
 */
export interface Layer {
  readonly id: string;
  readonly toolchains: readonly string[];
  /** apt packages, each pinned to an exact major.minor with a version glob (`name=1.93.*`). */
  readonly aptPackages: readonly string[];
  readonly files: readonly LayerFile[];
  /** Image environment, rendered as `ENV` lines after the files and before the steps. Literal values only. */
  readonly env?: Readonly<Record<string, string>>;
  /** Commands run as root after the packages and files are in place. */
  readonly steps: readonly Argv[];
}

export interface Preset {
  readonly id: PresetId;
  /** `<repo>@sha256:<64 hex>`: a digest, never a tag. */
  readonly base: string;
  /** The user, home and working directory the sandbox runs commands with. */
  readonly runtime: { readonly user: string; readonly home: string; readonly workdir: string };
  readonly layers: readonly Layer[];
  /** The one command that proves the toolchain is present. */
  readonly smokeCommand: Argv;
  /** Everything the image must run cleanly: `smokeCommand` first, then the laptop basics and any pinned tool. */
  readonly smokeCommands: readonly Argv[];
}
