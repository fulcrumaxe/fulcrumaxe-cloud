import { PRESETS, PRESET_IDS, type Layer } from "@fx/env-presets";
import { BASE_DIGEST, envVersionId, looksLikeImageRef, normalize, type EnvSpec } from "@fx/env-spec";
import { renderFooter, renderHeader, renderLayer } from "./dockerfile.js";
import { EnvBuildError } from "./errors.js";
import { rustToolchainLayer, versionToolsLayer, type RustToolchainFile, type VersionPin } from "./toolchains.js";

/** The registry rejects a layer over 500 MB compressed. */
export const MAX_LAYER_MB = 500;

export interface PlanOptions {
  /** The only input to the registry repository name. */
  readonly accountId: string;
  /** Compressed size in MB per apt package string (as a preset declares it, pin included). Absent means 0. */
  readonly sizeHints?: Readonly<Record<string, number>>;
  /** Tool versions read from the repo's version files by the pure parser (C3 section 5.6). */
  readonly versionPins?: readonly VersionPin[];
  /** The fields of the repo's `rust-toolchain(.toml)`, for a spec that names the `rust` preset (C3 section 6.1). */
  readonly rustToolchain?: RustToolchainFile;
  /** `inputsDigest(spec, tree)`, computed by the caller. Required whenever a version file or a rust toolchain file is passed. */
  readonly inputsDigest?: string;
}

export interface Plan {
  readonly dockerfile: string;
  readonly layers: readonly Layer[];
  /**
   * Ids of the layers whose steps a customer's files shape (B4). They are always last, so the builder logs in and
   * pushes only after every one has finished. The plan itself holds no credential, login or push.
   */
  readonly customerControlledLayers: readonly string[];
  /** `<repository>:<envVersionId>`: data for the builder that pushes later, never a command. */
  readonly tags: readonly string[];
  readonly envVersionId: string;
}

/** In-sandbox service packages (install only; the service is started per run, not baked). */
const SERVICE_PACKAGES: Readonly<Record<string, readonly string[]>> = { postgres: ["postgresql"], redis: ["redis-server"] };

const isPresetId = (v: unknown): boolean => typeof v === "string" && (PRESET_IDS as readonly string[]).includes(v);

/** Refusals that need only the spec, run first. */
function checkNames(spec: EnvSpec): void {
  const raw: unknown = spec.preset;
  // `preset` is a list in canonical form; a bare string is a list of one. An empty list names no preset.
  const ids: unknown[] = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  for (const p of ids) {
    if (typeof p === "string" && looksLikeImageRef(p)) throw new EnvBuildError("image_reference", "preset looks like a container image reference; use a preset id");
    if (!isPresetId(p)) throw new EnvBuildError("unknown_preset", `preset is not one of: ${PRESET_IDS.join(", ")}`);
  }
  const d: unknown = spec.dockerfile;
  if (d !== undefined) {
    if (typeof d === "string" && looksLikeImageRef(d)) throw new EnvBuildError("image_reference", "dockerfile looks like a container image reference");
    throw new EnvBuildError("dockerfile_source_not_planned", "Dockerfile builds are planned by a later task and are not available yet; use a preset for now");
  }
  if (spec.nix !== undefined) throw new EnvBuildError("nix_not_planned", "Nix builds are planned by a later task and are not available yet; use a preset for now");
  if (spec.image !== undefined) throw new EnvBuildError("image_not_planned", "imported images are planned by a later task and are not available yet; use a preset for now");
  if (ids.length === 0) throw new EnvBuildError("preset_required", "a preset is required; a spec without one has no base to plan yet");
  const services: unknown = spec.services ?? [];
  if (!Array.isArray(services)) throw new EnvBuildError("unknown_service", "services must be a list");
  for (const s of services as unknown[]) {
    if (typeof s === "string" && looksLikeImageRef(s)) throw new EnvBuildError("image_reference", "services entry looks like a container image reference");
    if (typeof s !== "string" || !Object.hasOwn(SERVICE_PACKAGES, s)) throw new EnvBuildError("unknown_service", "services entry must be postgres or redis");
  }
}

/** `<repo>@sha256:<hex>` -> the `sha256:<hex>` part. A tag or a missing digest is refused (C8). */
function digestOf(baseRef: string): string {
  const at = baseRef.lastIndexOf("@");
  const digest = at < 0 ? "" : baseRef.slice(at + 1);
  if (at <= 0 || !BASE_DIGEST.test(digest)) throw new EnvBuildError("base_not_pinned", "the base reference must be <repository>@sha256:<64 hex>, never a tag");
  return digest;
}

/** Splits a layer whose hinted apt packages exceed the limit into consecutive layers, each within it. */
function split(layer: Layer, hints: Readonly<Record<string, number>>): Layer[] {
  const size = (pkg: string): number => (Object.hasOwn(hints, pkg) ? hints[pkg]! : 0);
  const total = layer.aptPackages.reduce((n, p) => n + size(p), 0);
  if (total <= MAX_LAYER_MB) return [layer];
  const groups: string[][] = [[]];
  let cur = 0;
  for (const pkg of layer.aptPackages) {
    const s = size(pkg);
    if (s > MAX_LAYER_MB) throw new EnvBuildError("layer_too_large", `package in layer ${layer.id} is larger than ${MAX_LAYER_MB} MB on its own`);
    if (cur + s > MAX_LAYER_MB) { groups.push([]); cur = 0; }
    groups[groups.length - 1]!.push(pkg);
    cur += s;
  }
  // Files and steps run after the packages, so they ride with the last part.
  return groups.map((aptPackages, i) => ({
    ...layer, id: `${layer.id}-${i + 1}`, aptPackages,
    files: i === groups.length - 1 ? layer.files : [], steps: i === groups.length - 1 ? layer.steps : [],
  }));
}

/**
 * Pure: the same inputs give byte-identical output and nothing is read from the outside world.
 * `baseRef` is the full `<repo>@sha256:<64 hex>` reference the preset pins; only its digest reaches envVersionId.
 */
export function plan(spec: EnvSpec, baseRef: string, opts: PlanOptions): Plan {
  checkNames(spec);
  const digest = digestOf(baseRef);
  const s = normalize(spec);
  // Canonical order: sorted and de-duplicated, so the order a customer wrote the presets in cannot change the plan.
  const presets = s.preset!.map((id) => PRESETS.find((x) => x.id === id)!);
  if (presets.some((p) => p.base !== baseRef)) throw new EnvBuildError("base_mismatch", "the base reference does not match the preset's pinned base");
  if (typeof opts.accountId !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(opts.accountId)) {
    throw new EnvBuildError("invalid_account_id", "accountId must be lowercase letters, digits and hyphens");
  }
  const hints = opts.sizeHints ?? {};
  for (const v of Object.values(hints)) if (!Number.isFinite(v) || v < 0) throw new EnvBuildError("invalid_size_hint", "size hints must be non-negative numbers");

  if (opts.rustToolchain !== undefined && !s.preset!.includes("rust")) {
    throw new EnvBuildError("rust_toolchain_without_rust", "a rust-toolchain file is honoured only when the rust preset is named");
  }
  // Built before anything else is assembled so a refused file fails the plan with its own name.
  const customer = [
    ...(opts.rustToolchain === undefined ? [] : [rustToolchainLayer(opts.rustToolchain)]),
    ...[versionToolsLayer(opts.versionPins ?? [])].filter((l): l is Layer => l !== undefined),
  ];
  const inputs = opts.inputsDigest;
  if (inputs !== undefined && !/^[0-9a-f]{64}$/.test(inputs)) throw new EnvBuildError("invalid_inputs_digest", "inputsDigest must be 64 lowercase hex");
  if (customer.length > 0 && inputs === undefined) {
    throw new EnvBuildError("inputs_digest_required", "version files change the image, so the plan needs the inputsDigest that covers them");
  }

  const serviceLayers: Layer[] = s.services.map((name) => ({
    id: `service-${name}`, toolchains: [], aptPackages: SERVICE_PACKAGES[name]!, files: [], steps: [],
  }));
  // Order: the shared sandbox-base once, then one layer per preset in canonical order, then services, then the layers
  // that run steps shaped by customer files, last (B4: the builder logs in and pushes only after all of them).
  const shared = new Map(presets.flatMap((p) => p.layers).map((l) => [l.id, l] as const));
  const layers = [...shared.values(), ...serviceLayers, ...customer].flatMap((l) => split(l, hints));
  const id = envVersionId(spec, digest, inputs);
  const dockerfile = [...renderHeader(baseRef), ...layers.flatMap(renderLayer), ...renderFooter(presets[0]!.runtime)].join("\n") + "\n";
  return { dockerfile, layers, customerControlledLayers: customer.map((l) => l.id), tags: [`fx-env-${opts.accountId}:${id}`], envVersionId: id };
}
