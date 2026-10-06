/**
 * Same result shape as @fx/sitekit-checks (src/types.ts:1-22) so a gate is a
 * drop-in `run(renderedDir, options)`: deterministic, no network, no model
 * call, nothing written outside renderedDir.
 */
export interface Finding {
  /** Page or file path relative to renderedDir (leading "/"). */
  path: string;
  /** Machine-stable reason code. */
  kind: string;
  /** Human-readable detail. Never contains a full secret value. */
  message: string;
  severity: "error" | "advisory";
  /** Masked display form of the subject link (no userinfo, no query values). Set on link findings only. */
  subject?: string;
}

export interface GateResult {
  ok: boolean;
  findings: Finding[];
  summary?: Record<string, number>;
}
