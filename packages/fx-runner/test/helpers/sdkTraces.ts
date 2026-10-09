/**
 * The one definition of "this file carries the Claude Agent SDK" (D#6 C2 R6.3, the technique of packages/runtime's bundle-isolation test):
 * the SDK's package path, and identifiers that exist only in its code and survive bundling as property names.
 */
export const SDK_SIGNALS: readonly string[] = ["@anthropic-ai/", "claude-agent-sdk", "claude-code-sdk", "createSdkMcpServer", "unstable_v2_createSession"];

export function sdkTraces(content: Buffer | string): string[] {
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  return SDK_SIGNALS.filter((signal) => bytes.includes(signal));
}
