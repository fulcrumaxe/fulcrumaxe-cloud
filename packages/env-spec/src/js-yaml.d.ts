// js-yaml 4 ships no types and @types/js-yaml is not in the lockfile; declare only what parse.ts uses.
declare module "js-yaml" {
  export type Schema = object;
  export const CORE_SCHEMA: Schema;
  export class YAMLException extends Error {
    reason: string;
    mark?: { line: number; column: number } | null;
  }
  /** The parser state js-yaml hands its node listener (only the fields parse.ts reads). */
  export interface ListenerState { anchor: string | null; line: number }
  export function load(input: string, options?: { schema?: Schema; listener?: (phase: "open" | "close", state: ListenerState) => void }): unknown;
}
