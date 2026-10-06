export type ErrorCode =
  | "yaml_syntax" | "yaml_unsafe" | "limit_exceeded" | "invalid_type" | "invalid_value"
  | "forbidden_field" | "unknown_field" | "string_form_command" | "image_reference"
  | "unknown_preset" | "forbidden_env_name";

export type Path = readonly (string | number)[];

export const fieldName = (path: Path): string =>
  path.reduce<string>((acc, s) => (typeof s === "number" ? `${acc}[${s}]` : acc ? `${acc}.${s}` : s), "") || "(document)";

/** Names the offending field and, once parse() has located it, the 1-based line. Never carries a field's value. */
export class EnvSpecError extends Error {
  constructor(readonly code: ErrorCode, readonly path: Path, detail: string, public line: number | null = null) {
    super(`${fieldName(path)}: ${detail}`);
    this.name = "EnvSpecError";
  }
  get field(): string {
    return fieldName(this.path);
  }
}
