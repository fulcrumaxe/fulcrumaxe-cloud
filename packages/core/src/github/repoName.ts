/**
 * D#2 RC-1a (C61 section 3 items 3-4): validation for a new customer repo.
 * Names are refused rather than rewritten, because GitHub silently rewrites
 * some of them. One pure function, used by the create route, the callback and
 * (through a copied constant table) the UI.
 */
export const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
export const DESCRIPTION_MAX = 350;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

export type NewRepoVisibility = "private" | "public";

export interface NewRepoInput {
  name: unknown;
  /** Absent means private. `internal` is refused at Launch. */
  visibility?: unknown;
  description?: unknown;
  /** Absent means true. */
  autoInit?: unknown;
}

export interface ValidNewRepo {
  name: string;
  visibility: NewRepoVisibility;
  description: string | null;
  autoInit: boolean;
}

export type NewRepoValidation =
  | { ok: true; value: ValidNewRepo }
  | { ok: false; path: "name" | "visibility" | "description" | "auto_init" };

export function validateNewRepo(input: NewRepoInput): NewRepoValidation {
  const { name } = input;
  if (typeof name !== "string" || !REPO_NAME_RE.test(name) || name === "." || name === ".." || name.toLowerCase().endsWith(".git")) {
    return { ok: false, path: "name" };
  }
  const visibility = input.visibility ?? "private";
  if (visibility !== "private" && visibility !== "public") return { ok: false, path: "visibility" };

  let description: string | null = null;
  if (input.description !== undefined && input.description !== null) {
    if (typeof input.description !== "string") return { ok: false, path: "description" };
    const trimmed = input.description.trim();
    if (trimmed.length > DESCRIPTION_MAX || CONTROL_RE.test(trimmed)) return { ok: false, path: "description" };
    description = trimmed === "" ? null : trimmed;
  }
  const autoInit = input.autoInit ?? true;
  if (typeof autoInit !== "boolean") return { ok: false, path: "auto_init" };
  return { ok: true, value: { name, visibility, description, autoInit } };
}
