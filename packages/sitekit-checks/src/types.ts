/** A single problem (or advisory note) a check found. */
export interface Finding {
  /** Page or file path the finding applies to, relative to renderedDir (leading "/"). */
  path: string;
  /** Short machine-stable reason code, e.g. "broken_link", "missing_title". */
  kind: string;
  /** Human-readable detail. */
  message: string;
  /** "error" fails the check; "advisory" is reported but never fails it. */
  severity: "error" | "advisory";
  /** Viewport width in px, for findings that apply to one viewport. */
  viewport?: number;
  /** CSS selector of the offending element, where one applies. */
  selector?: string;
  /** One line telling the site owner what to change. */
  hint?: string;
}

export interface CheckResult {
  ok: boolean;
  findings: Finding[];
  /** Free-form summary counters a caller may want (files checked, etc). Never used for pass/fail. */
  summary?: Record<string, number>;
}

export type CheckOptions = Record<string, unknown>;

export type CheckRun = (renderedDir: string, options?: CheckOptions) => Promise<CheckResult>;
