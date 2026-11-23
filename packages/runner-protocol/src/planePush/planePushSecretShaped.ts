import { redactShapes } from "../redact.js";

/**
 * The `secret_shaped` rule of the export mode (ON-27c1): true when the run path's credential redactor would change the line. The pattern list
 * is the one in ../redact.ts (the run path's own); nothing is copied. Kept out of the scan module, which stays pure, and passed to it by the route.
 */
export const secretShaped = (line: string): boolean => redactShapes(line) !== line;
