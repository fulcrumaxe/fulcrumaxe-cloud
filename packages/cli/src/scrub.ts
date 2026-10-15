/** Every byte the CLI writes passes this: anything shaped like a token loses its secret part. */
export function scrub(text: string): string {
  return text.replace(/fxat_[0-9A-Za-z]+/g, "fxat_[redacted]");
}

/**
 * Server-provided text must not drive the terminal (CWE-150): drops C0 controls (ESC, CR, backspace, bell, ...), DEL and C1 controls, keeping only
 * newline and tab. It runs before `scrub`, so a token split by control characters is still redacted.
 */
export function stripControl(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}
