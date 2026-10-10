/** The part of js-yaml (4.x, which ships no types) that the runner's lockfile pre-check and the tests use. */
declare module "js-yaml" {
  export interface LoadOptions {
    schema?: unknown;
    listener?: (event: "open" | "close", state: { anchor?: string | null }) => void;
  }
  export const JSON_SCHEMA: unknown;
  export function load(text: string, options?: LoadOptions): unknown;
}
