/**
 * Paths under `/repos/{owner}/{repo}/...` that merge a PR or change
 * protection/collaborator/hook/key state. No role may ever reach these,
 * regardless of product or per-role permissions (H03 criterion 4).
 */
const MERGE_PROTECTION_RULES: ReadonlyArray<{ methods: ReadonlySet<string>; re: RegExp }> = [
  { methods: new Set(["PUT"]), re: /^\/pulls\/\d+\/merge$/ },
  { methods: new Set(["POST"]), re: /^\/merges$/ },
  { methods: new Set(["PATCH", "PUT", "POST", "DELETE"]), re: /^\/branches\/[^/]+\/protection(\/.*)?$/ },
  { methods: new Set(["PATCH", "PUT", "POST", "DELETE"]), re: /^\/rulesets(\/.*)?$/ },
  { methods: new Set(["PATCH", "PUT", "POST", "DELETE"]), re: /^\/collaborators(\/.*)?$/ },
  { methods: new Set(["PATCH", "PUT", "POST", "DELETE"]), re: /^\/hooks(\/.*)?$/ },
  { methods: new Set(["PATCH", "PUT", "POST", "DELETE"]), re: /^\/keys(\/.*)?$/ },
];

/** True when `method subpath` is a merge or a protection/collaborator/hook/key mutation. */
export function isMergeOrProtectionPath(method: string, subpath: string): boolean {
  return MERGE_PROTECTION_RULES.some((rule) => rule.methods.has(method) && rule.re.test(subpath));
}
