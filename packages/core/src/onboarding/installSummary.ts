/**
 * D#845 ON-20a: what a person is shown before they merge the install pull request. Pure: the files come from the pull request as GitHub lists it (read at the commit the runner pushed), and the answer is the
 * Spec's six fixed categories with fixed copy, counts of files added and files changed (kept apart) and of lines, and the path of every file as plain data for the UI to render as text. No other text of the
 * pull request or the repository (a title, a body, a patch) is in it.
 */

export interface InstallFile {
  path: string;
  /** GitHub's change type, verbatim: `ADDED` is an added file, anything else (`MODIFIED`, `RENAMED`, ...) a changed one. */
  changeType: string;
  additions: number;
  deletions: number;
}

/** The categories, in the order they are shown. The first one a path fits is its own; "other" takes the rest, so every file is in exactly one. `label` takes the count of its own files where the copy has an N. */
export const INSTALL_SUMMARY_CATEGORIES = [
  { id: "plan", label: (_n: number, epics: number) => `Your project plan (\`docs/PRD.md\`, roadmap, ${epics} epics)`, fits: (p: string) => p === "docs/PRD.md" || p === ".autonomous-team/roadmap.json" || p.startsWith("epics/") },
  { id: "team", label: () => "The team's settings (`.autonomous-team/`)", fits: (p: string) => p.startsWith(".autonomous-team/") },
  { id: "scripts", label: (n: number) => `${n} helper scripts (\`scripts/\`)`, fits: (p: string) => p.startsWith("scripts/") },
  { id: "agents", label: () => "The agents' instructions (`CLAUDE.md`, `.claude/`)", fits: (p: string) => p === "CLAUDE.md" || p.startsWith(".claude/") },
  { id: "hook", label: () => "The sandbox hook", fits: (p: string) => p === "hooks/sandbox.py" || p === "hooks/sandbox_rules.py" },
  { id: "other", label: (n: number) => `${n} other files`, fits: () => true },
] as const;

export interface InstallSummaryCounts {
  files: number;
  added_files: number;
  changed_files: number;
  additions: number;
  deletions: number;
}
export interface InstallSummaryCategory extends InstallSummaryCounts {
  id: (typeof INSTALL_SUMMARY_CATEGORIES)[number]["id"];
  label: string;
}
export interface InstallSummary {
  totals: InstallSummaryCounts;
  /** Only categories that hold a file, in the fixed order. */
  categories: InstallSummaryCategory[];
  /** Every file's path, sorted, as plain data (the UI renders it as text). */
  paths: string[];
}

const zero = (): InstallSummaryCounts => ({ files: 0, added_files: 0, changed_files: 0, additions: 0, deletions: 0 });
const add = (c: InstallSummaryCounts, f: InstallFile): void => {
  c.files += 1;
  if (f.changeType === "ADDED") c.added_files += 1;
  else c.changed_files += 1;
  c.additions += f.additions;
  c.deletions += f.deletions;
};

export function summarizeInstall(files: readonly InstallFile[]): InstallSummary {
  const rows = INSTALL_SUMMARY_CATEGORIES.map((c) => ({ id: c.id, ...zero() }));
  const totals = zero();
  let epics = 0;
  for (const f of files) {
    add(rows[INSTALL_SUMMARY_CATEGORIES.findIndex((c) => c.fits(f.path))]!, f);
    add(totals, f);
    if (f.path.startsWith("epics/")) epics += 1;
  }
  return {
    totals,
    categories: rows.filter((r) => r.files > 0).map((r) => ({ ...r, label: INSTALL_SUMMARY_CATEGORIES.find((c) => c.id === r.id)!.label(r.files, epics) })),
    paths: files.map((f) => f.path).sort(),
  };
}
